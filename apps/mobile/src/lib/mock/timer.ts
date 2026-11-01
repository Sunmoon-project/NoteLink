import type { StudyRoom, TimerRule } from '@notelink/shared';

/** 목업 서버의 공통 시작 시각으로 현재 단계를 계산한다. 참여자의 입장 시각은 사용하지 않는다. */
export function roomTimerState(
  rule: TimerRule | null,
  startedAt: number,
  now = Date.now(),
): StudyRoom['timerState'] {
  if (!rule?.enabled) return null;
  if (rule.type === 'period') {
    const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
    const periods = rule.periods
      .map((p) => ({
        start: Date.parse(`${day}T${p.start.padStart(5, '0')}:00+09:00`),
        end: Date.parse(`${day}T${p.end.padStart(5, '0')}:00+09:00`),
      }))
      .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.start < p.end)
      .sort((a, b) => a.start - b.start);
    const current = periods.find((p) => now >= p.start && now < p.end);
    if (current) return { phase: 'period', endsAt: new Date(current.end).toISOString() };
    const next = periods.find((p) => p.start > now);
    return next ? { phase: 'break', endsAt: new Date(next.start).toISOString() } : null;
  }
  const focus = rule.focusMin * 60000;
  const rest = rule.breakMin * 60000;
  const cycle = focus + rest;
  if (!(focus > 0) || !(rest >= 0) || !Number.isFinite(cycle) || !(rule.repeat > 0)) return null;
  const elapsed = Math.max(0, now - startedAt);
  const round = Math.floor(elapsed / cycle);
  if (round >= rule.repeat) return null;
  const inFocus = elapsed % cycle < focus;
  return {
    phase: inFocus ? 'focus' : 'break',
    endsAt: new Date(startedAt + round * cycle + (inFocus ? focus : cycle)).toISOString(),
  };
}
