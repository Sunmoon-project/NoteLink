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
    return next ? { phase: 'break', endsAt: new Date(next.start).toISOString() } : null;
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
