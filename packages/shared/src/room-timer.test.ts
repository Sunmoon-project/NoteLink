import { describe, expect, it } from 'vitest';
import { nextRoomTimerTransitionAt, roomTimerState } from './room-timer.js';
import type { TimerRule } from './schemas.js';

const pomodoro: TimerRule = {
  enabled: true,
  type: 'pomodoro',
  focusMin: 25,
  breakMin: 5,
  repeat: 2,
  periods: [],
};

describe('roomTimerState', () => {
  it('모든 참여자에게 같은 방 기준 집중·휴식 종료 시각을 계산한다', () => {
    const startedAt = Date.parse('2026-11-15T00:00:00.000Z');
    expect(roomTimerState(pomodoro, startedAt, startedAt + 10 * 60_000)).toEqual({
      phase: 'focus',
      endsAt: '2026-11-15T00:25:00.000Z',
    });
    expect(roomTimerState(pomodoro, startedAt, startedAt + 27 * 60_000)).toEqual({
      phase: 'break',
      endsAt: '2026-11-15T00:30:00.000Z',
    });
  });

  it('마지막 반복이 끝나면 타이머를 비운다', () => {
    const startedAt = Date.parse('2026-11-15T00:00:00.000Z');
    expect(roomTimerState(pomodoro, startedAt, startedAt + 60 * 60_000)).toBeNull();
  });

  it('교시제는 서울 기준 오늘의 현재 교시 또는 다음 시작 시각을 반환한다', () => {
    const rule: TimerRule = {
      ...pomodoro,
      type: 'period',
      periods: [{ start: '09:00', end: '09:50', label: '1교시' }],
    };
    const now = Date.parse('2026-11-15T00:10:00.000Z');
    expect(roomTimerState(rule, null, now)).toEqual({
      phase: 'period',
      endsAt: '2026-11-15T00:50:00.000Z',
    });
  });

  it('오늘 마지막 교시가 끝나면 화면 상태는 비우고 다음 날 첫 교시는 별도 예약한다', () => {
    const rule: TimerRule = {
      ...pomodoro,
      type: 'period',
      periods: [
        { start: '09:00', end: '09:50', label: '1교시' },
        { start: '15:00', end: '15:50', label: '마지막 교시' },
      ],
    };
    const afterLastPeriod = Date.parse('2026-11-15T07:00:00.000Z');

    expect(roomTimerState(rule, null, afterLastPeriod)).toBeNull();
    expect(nextRoomTimerTransitionAt(rule, null, afterLastPeriod)).toBe('2026-11-16T00:00:00.000Z');
  });

  it.each([
    ['서울 자정 직전', '2026-11-15T14:59:59.000Z', '2026-11-15T15:00:00.000Z'],
    ['서울 자정 직후', '2026-11-15T15:00:01.000Z', '2026-11-15T15:50:00.000Z'],
  ])('%s에도 다음 교시를 서울 날짜 기준으로 예약한다', (_label, now, expected) => {
    const rule: TimerRule = {
      ...pomodoro,
      type: 'period',
      periods: [
        { start: '00:00', end: '00:50', label: '자정 교시' },
        { start: '09:00', end: '09:50', label: '오전 교시' },
      ],
    };

    expect(nextRoomTimerTransitionAt(rule, null, Date.parse(now))).toBe(expected);
  });

  it.each(['2026-11-02T01:50:00.000Z', '2026-11-02T12:00:00.000Z'])(
    '마지막 교시 종료 이후 %s에는 화면에 실행 중 단계가 없다',
    (value) => {
      const rule: TimerRule = {
        ...pomodoro,
        type: 'period',
        periods: [{ start: '09:00', end: '10:50', label: '오전 교시' }],
      };
      expect(roomTimerState(rule, null, Date.parse(value))).toBeNull();
    },
  );

  it('꺼진 규칙이나 시작 시각이 없는 뽀모도로는 활성 상태로 보이지 않는다', () => {
    expect(roomTimerState({ ...pomodoro, enabled: false }, Date.now())).toBeNull();
    expect(roomTimerState(pomodoro, null)).toBeNull();
  });
});
