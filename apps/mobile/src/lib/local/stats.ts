import type { StudySession } from '@notelink/shared';
import { addDays, parse, seoul, ymd } from '../dates';

// 공부 기록 계산 — 모두 저장된 세션에서 계산한다 (서버도 같은 규칙으로 계산한다)

/** 하루 기준: 10분 이상 공부한 날을 '공부한 날' · 스트릭으로 센다 (FR-09-09) */
export const STREAK_MIN_SEC = 10 * 60;
/** 하루 최대 순공 시간 16시간 (FR-06-15) */
export const DAILY_CAP_SEC = 16 * 3600;
/** 24시간 넘게 이어진 세션은 방치로 보고 통계에서 뺀다 (FR-06-16) */
export const ABUSE_SEC = 24 * 3600;

/** 날짜(YYYY-MM-DD, 서울)별 순공 초. 끝난 세션 · 어뷰징 아닌 것만 */
export function dailyTotals(sessions: StudySession[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions)
    if (s.status === 'ended' && !s.isAbuse)
      m.set(s.studyDate, Math.min(DAILY_CAP_SEC, (m.get(s.studyDate) ?? 0) + s.durationSec));
  return m;
}

/** 쉰 시간을 뺀 공부 시간을 서울 날짜별 초로 나눈다 (자정을 넘긴 세션) */
export function secondsBySeoulDay(
  startMs: number,
  endMs: number,
  pauses: { startMs: number; endMs: number }[],
): Map<string, number> {
  const ms = new Map<string, number>();
  const add = (from: number, to: number) => {
    let at = from;
    while (at < to) {
      const day = ymd(seoul(at));
      const midnight = Date.parse(`${ymd(addDays(parse(day), 1))}T00:00:00+09:00`);
      const until = Math.min(to, midnight);
      ms.set(day, (ms.get(day) ?? 0) + until - at);
      at = until;
    }
  };
  let at = startMs;
  for (const p of [...pauses].sort((a, b) => a.startMs - b.startMs)) {
    add(at, Math.min(p.startMs, endMs));
    at = Math.max(at, p.endMs);
  }
  add(at, endMs);
  return new Map([...ms].map(([day, v]) => [day, Math.floor(v / 1000)]));
}

/** 이번 주 월요일 (서울) */
export const weekStart = (date = ymd(seoul())) => {
  const d = parse(date);
  return ymd(addDays(d, -((d.getDay() + 6) % 7)));
};

export const sumRange = (totals: Map<string, number>, start: string, days: number) => {
  let sec = 0;
  for (let i = 0; i < days; i++) sec += totals.get(ymd(addDays(parse(start), i))) ?? 0;
  return sec;
};

/** 오늘(또는 오늘 아직 안 했으면 어제)까지 이어진 연속 공부일 */
export function currentStreak(totals: Map<string, number>, today = ymd(seoul())) {
  let d = parse(today);
  if ((totals.get(today) ?? 0) < STREAK_MIN_SEC) d = addDays(d, -1);
  let n = 0;
  while ((totals.get(ymd(d)) ?? 0) >= STREAK_MIN_SEC) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

/** 기간 안에서 가장 길게 이어진 연속 공부일 */
export function longestStreak(totals: Map<string, number>, from: string, to: string) {
  let best = 0;
  let run = 0;
  for (let d = parse(from); ymd(d) <= to; d = addDays(d, 1)) {
    run = (totals.get(ymd(d)) ?? 0) >= STREAK_MIN_SEC ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

/** 공부 시간 → 캘린더 색 진하기 0 ~ 4 */
export const levelOf = (sec: number) =>
  sec <= 0 ? 0 : sec < 30 * 60 ? 1 : sec < 60 * 60 ? 2 : sec < 2 * 3600 ? 3 : 4;

/** 가장 많이 공부를 시작한 시각(0 ~ 23, 서울). 기록이 없으면 null */
export function peakHour(sessions: StudySession[]) {
  const count = new Array<number>(24).fill(0);
  for (const s of sessions)
    if (s.status === 'ended' && !s.isAbuse) {
      const h = seoul(s.startedAt).getHours();
      count[h] = (count[h] ?? 0) + s.durationSec;
    }
  const max = Math.max(...count);
  return max > 0 ? count.indexOf(max) : null;
}
