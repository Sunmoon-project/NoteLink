import type { StudyRoom, TimerRule } from './schemas.js';

/** 방의 공통 시작 시각과 서버 시각 기준으로 현재 타이머 단계를 계산한다. */
export function roomTimerState(
  rule: TimerRule | null | undefined,
  startedAt: Date | number | string | null | undefined,
  now = Date.now(),
): StudyRoom['timerState'] {
  if (!rule?.enabled) return null;

  if (rule.type === 'period') {
    const day = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const periods = rule.periods
      .map((period) => ({
        start: Date.parse(`${day}T${period.start.padStart(5, '0')}:00+09:00`),
        end: Date.parse(`${day}T${period.end.padStart(5, '0')}:00+09:00`),
      }))
      .filter(
        (period) =>
          Number.isFinite(period.start) && Number.isFinite(period.end) && period.start < period.end,
      )
      .sort((a, b) => a.start - b.start);
    const current = periods.find((period) => now >= period.start && now < period.end);
    if (current) return { phase: 'period', endsAt: new Date(current.end).toISOString() };
    const next = periods.find((period) => period.start > now);
    if (next) return { phase: 'break', endsAt: new Date(next.start).toISOString() };
    return null;
  }

  const startedAtMs =
    startedAt instanceof Date
      ? startedAt.getTime()
      : typeof startedAt === 'string'
        ? Date.parse(startedAt)
        : startedAt;
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null;

  const focus = rule.focusMin * 60_000;
  const rest = rule.breakMin * 60_000;
  const cycle = focus + rest;
  if (!(focus > 0) || !(rest >= 0) || !Number.isFinite(cycle) || !(rule.repeat > 0)) return null;

  const elapsed = Math.max(0, now - startedAtMs);
  const round = Math.floor(elapsed / cycle);
  if (round >= rule.repeat) return null;
  const inFocus = elapsed % cycle < focus;
  return {
    phase: inFocus ? 'focus' : 'break',
    endsAt: new Date(startedAtMs + round * cycle + (inFocus ? focus : cycle)).toISOString(),
  };
}

/** 타이머 화면의 현재 상태와 별도로, 서버 스케줄러가 예약할 다음 단계 전환 시각을 계산한다. */
export function nextRoomTimerTransitionAt(
  rule: TimerRule | null | undefined,
  startedAt: Date | number | string | null | undefined,
  now = Date.now(),
): string | null {
  if (!rule?.enabled) return null;
  if (rule.type !== 'period') return roomTimerState(rule, startedAt, now)?.endsAt ?? null;

  const day = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const periods = rule.periods
    .map((period) => ({
      start: Date.parse(`${day}T${period.start.padStart(5, '0')}:00+09:00`),
      end: Date.parse(`${day}T${period.end.padStart(5, '0')}:00+09:00`),
    }))
    .filter(
      (period) =>
        Number.isFinite(period.start) && Number.isFinite(period.end) && period.start < period.end,
    )
    .sort((a, b) => a.start - b.start);
  const current = periods.find((period) => now >= period.start && now < period.end);
  if (current) return new Date(current.end).toISOString();
  const next = periods.find((period) => period.start > now);
  if (next) return new Date(next.start).toISOString();

  const [year, month, date] = day.split('-').map(Number);
  const nextDay = new Date(Date.UTC(year!, month! - 1, date! + 1)).toISOString().slice(0, 10);
  const firstTomorrow = rule.periods
    .map((period) => Date.parse(`${nextDay}T${period.start.padStart(5, '0')}:00+09:00`))
    .filter((start) => Number.isFinite(start) && start > now)
    .sort((a, b) => a - b)[0];
  return firstTomorrow ? new Date(firstTomorrow).toISOString() : null;
}
