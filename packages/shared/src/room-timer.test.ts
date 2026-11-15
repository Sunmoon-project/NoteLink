import { describe, expect, it } from 'vitest';
import { roomTimerState } from './room-timer.js';
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

  it('오늘 마지막 교시가 끝난 뒤 다음 날 첫 교시 시작 시각을 반환한다', () => {
    const rule: TimerRule = {
      ...pomodoro,
      type: 'period',
      periods: [
        { start: '09:00', end: '09:50', label: '1교시' },
        { start: '15:00', end: '15:50', label: '마지막 교시' },
      ],
    };
    const afterLastPeriod = Date.parse('2026-11-15T07:00:00.000Z');

    expect(roomTimerState(rule, null, afterLastPeriod)).toEqual({
      phase: 'break',
      endsAt: '2026-11-16T00:00:00.000Z',
    });
  });

  it('꺼진 규칙이나 시작 시각이 없는 뽀모도로는 활성 상태로 보이지 않는다', () => {
    expect(roomTimerState({ ...pomodoro, enabled: false }, Date.now())).toBeNull();
    expect(roomTimerState(pomodoro, null)).toBeNull();
  });
});
