import type { TimerRule } from '@notelink/shared';
import { roomTimerState } from '../lib/mock/timer';

const PERIOD_RULE: TimerRule = {
  enabled: true,
  type: 'period',
  focusMin: 25,
  breakMin: 5,
  repeat: 2,
  // 입력 순서와 관계없이 서울 날짜의 실제 시간순으로 찾는다.
  periods: [
    { start: '10:00', end: '10:50', label: '두 번째 교시' },
    { start: '09:00', end: '09:50', label: '첫 번째 교시' },
  ],
};
const POMODORO_RULE: TimerRule = {
  ...PERIOD_RULE,
  type: 'pomodoro',
  periods: [],
};
const STARTED_AT = Date.parse('2026-11-01T00:00:00.000Z');

describe('목업 서버 교시 타이머 — 서울 날짜와 UTC 종료 시각', () => {
  it.each([
    {
      name: '서울 자정',
      now: '2026-11-01T15:00:00.000Z',
      phase: 'break',
      endsAt: '2026-11-02T00:00:00.000Z',
    },
    {
      name: '첫 교시 직전',
      now: '2026-11-01T23:59:59.999Z',
      phase: 'break',
      endsAt: '2026-11-02T00:00:00.000Z',
    },
    {
      name: '첫 교시 시작',
      now: '2026-11-02T00:00:00.000Z',
      phase: 'period',
      endsAt: '2026-11-02T00:50:00.000Z',
    },
    {
      name: '첫 교시 도중',
      now: '2026-11-02T00:25:00.000Z',
      phase: 'period',
      endsAt: '2026-11-02T00:50:00.000Z',
    },
    {
      name: '첫 교시 종료 경계',
      now: '2026-11-02T00:50:00.000Z',
      phase: 'break',
      endsAt: '2026-11-02T01:00:00.000Z',
    },
    {
      name: '교시 사이',
      now: '2026-11-02T00:55:00.000Z',
      phase: 'break',
      endsAt: '2026-11-02T01:00:00.000Z',
    },
    {
      name: '두 번째 교시 시작',
      now: '2026-11-02T01:00:00.000Z',
      phase: 'period',
      endsAt: '2026-11-02T01:50:00.000Z',
    },
    {
      name: '다음 서울 날짜',
      now: '2026-11-02T15:10:00.000Z',
      phase: 'break',
      endsAt: '2026-11-03T00:00:00.000Z',
    },
  ] as const)('$name의 단계와 종료 시각을 계산한다', ({ now, phase, endsAt }) => {
    expect(roomTimerState(PERIOD_RULE, STARTED_AT, Date.parse(now))).toEqual({ phase, endsAt });
  });
  it.each(['2026-11-02T01:50:00.000Z', '2026-11-02T12:00:00.000Z'])(
    '마지막 교시 종료 이후 %s에는 실행 중 단계가 없다',
    (now) => expect(roomTimerState(PERIOD_RULE, STARTED_AT, Date.parse(now))).toBeNull(),
  );
  it('유효하지 않은 교시는 건너뛰고 다음 유효 교시를 찾는다', () => {
    const rule: TimerRule = {
      ...PERIOD_RULE,
      periods: [
        { start: '25:00', end: '26:00', label: '잘못된 시각' },
        { start: '08:30', end: '08:00', label: '종료가 앞선 교시' },
        { start: '09:00', end: '09:00', label: '길이 0' },
        { start: '10:00', end: '10:50', label: '정상 교시' },
      ],
    };
    expect(roomTimerState(rule, STARTED_AT, Date.parse('2026-11-02T00:00:00.000Z'))).toEqual({
      phase: 'break',
      endsAt: '2026-11-02T01:00:00.000Z',
    });
  });
  it('교시가 없으면 실행 중 단계가 없다', () => {
    expect(roomTimerState({ ...PERIOD_RULE, periods: [] }, STARTED_AT, STARTED_AT)).toBeNull();
  });
});

describe('목업 서버 뽀모도로 — 공통 시작 시각과 정확한 단계 경계', () => {
  it.each([
    { now: '2026-11-01T00:00:00.000Z', phase: 'focus', endsAt: '2026-11-01T00:25:00.000Z' },
    { now: '2026-11-01T00:24:59.999Z', phase: 'focus', endsAt: '2026-11-01T00:25:00.000Z' },
    { now: '2026-11-01T00:25:00.000Z', phase: 'break', endsAt: '2026-11-01T00:30:00.000Z' },
    { now: '2026-11-01T00:29:59.999Z', phase: 'break', endsAt: '2026-11-01T00:30:00.000Z' },
    { now: '2026-11-01T00:30:00.000Z', phase: 'focus', endsAt: '2026-11-01T00:55:00.000Z' },
    { now: '2026-11-01T00:55:00.000Z', phase: 'break', endsAt: '2026-11-01T01:00:00.000Z' },
  ] as const)('$now에는 $phase가 $endsAt까지 이어진다', ({ now, phase, endsAt }) => {
    expect(roomTimerState(POMODORO_RULE, STARTED_AT, Date.parse(now))).toEqual({ phase, endsAt });
  });
  it.each(['2026-11-01T01:00:00.000Z', '2026-11-01T02:00:00.000Z'])(
    '반복 횟수를 마친 %s에는 실행 중 단계가 없다',
    (now) => expect(roomTimerState(POMODORO_RULE, STARTED_AT, Date.parse(now))).toBeNull(),
  );
  it('같은 방에 늦게 들어와도 공통 집중 종료 시각이 바뀌지 않는다', () => {
    const early = roomTimerState(POMODORO_RULE, STARTED_AT, Date.parse('2026-11-01T00:03:00.000Z'));
    const late = roomTimerState(POMODORO_RULE, STARTED_AT, Date.parse('2026-11-01T00:23:00.000Z'));
    expect(early).toEqual({ phase: 'focus', endsAt: '2026-11-01T00:25:00.000Z' });
    expect(late).toEqual(early);
  });
  it('휴식이 0분이면 집중 종료 경계에서 즉시 다음 집중으로 넘어간다', () => {
    const rule = { ...POMODORO_RULE, breakMin: 0 };
    expect(roomTimerState(rule, STARTED_AT, Date.parse('2026-11-01T00:25:00.000Z'))).toEqual({
      phase: 'focus',
      endsAt: '2026-11-01T00:50:00.000Z',
    });
    expect(roomTimerState(rule, STARTED_AT, Date.parse('2026-11-01T00:50:00.000Z'))).toBeNull();
  });
});

describe('목업 서버 타이머 비활성화와 잘못된 길이', () => {
  it.each([PERIOD_RULE, POMODORO_RULE])('비활성화된 $type 규칙은 단계가 없다', (rule) => {
    expect(roomTimerState({ ...rule, enabled: false }, STARTED_AT, STARTED_AT)).toBeNull();
  });
  it('규칙이 없으면 단계가 없다', () => {
    expect(roomTimerState(null, STARTED_AT, STARTED_AT)).toBeNull();
  });
  it.each([
    { focusMin: 0 },
    { focusMin: -1 },
    { focusMin: Number.NaN },
    { focusMin: Number.POSITIVE_INFINITY },
    { breakMin: -1 },
    { breakMin: Number.NaN },
    { breakMin: Number.POSITIVE_INFINITY },
    { repeat: 0 },
    { repeat: -1 },
    { repeat: Number.NaN },
  ])('잘못된 시간·반복 값 %j은 실행하지 않는다', (invalid) => {
    expect(roomTimerState({ ...POMODORO_RULE, ...invalid }, STARTED_AT, STARTED_AT)).toBeNull();
  });
});
