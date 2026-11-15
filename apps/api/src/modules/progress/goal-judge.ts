// 반복 목표 달성 판정 (순수 함수, FR-11-06 · 11, FR-12-04). DB · 시계를 읽지 않고 받은 값만으로 계산한다.
// 날짜는 모두 서울 기준 'YYYY-MM-DD' 글자이고, 한 주는 월~일이다.
import { addDays, weekStartOf } from './week.js';

/** 판정에 쓰는 목표 정보 */
export interface GoalRule {
    isActive: boolean; // false면 연속 달성 주 수는 0
    days: number[]; // 0=일 ... 6=토
    targetSec: number;
    subjectId: string | null; // 있으면 그 과목에서 쌓은 시간만 센다
    createdDate: string; // 만든 날(서울). 이전 날짜는 판정하지 않는다
    pausedUntil: string | null; // 이 날(서울 날짜)까지 쉰다(그 날 포함)
}

/** 하루 공부 기록 (daily_records에서 필요한 것만) */
export interface DayStudy {
    totalSec: number;
    bySubject: Map<string, number>; // 과목 id -> 그날 쌓인 초
}

/**
 * none: 목표 날이 아님 / skipped: 공휴일 · 제외일 · 쉬는 날이라 세지도 끊지도 않음
 * pending: 아직 끝나지 않음(오늘 아직 못 채웠거나 앞으로 올 날) / achieved / missed
 */
export type Verdict = 'none' | 'skipped' | 'pending' | 'achieved' | 'missed';

/** 거슬러 올라가는 최대 주 수(무한 반복 방지). 서비스가 읽는 기간(2년)보다 넉넉하다 */
const MAX_WEEKS = 520;

/** 그 날짜의 요일 번호 (0=일 ... 6=토) */
const weekdayOf = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();

/** 하루를 판정한다. today는 서울 기준 오늘 */
export function judgeDay(
    goal: GoalRule,
    day: string,
    today: string,
    study: ReadonlyMap<string, DayStudy>,
    skipDates: ReadonlySet<string>,
): Verdict {
    if (!goal.days.includes(weekdayOf(day)) || day < goal.createdDate) return 'none';
    if (skipDates.has(day) || (goal.pausedUntil !== null && day <= goal.pausedUntil)) return 'skipped';
    if (day > today) return 'pending';

    const record = study.get(day);
    const sec = goal.subjectId === null ? (record?.totalSec ?? 0) : (record?.bySubject.get(goal.subjectId) ?? 0);
    if (sec >= goal.targetSec) return 'achieved';
    return day === today ? 'pending' : 'missed'; // 오늘은 하루가 끝나기 전이라 미달성으로 단정하지 않는다
}

/**
 * 연속으로 달성한 주 수: 지난 주부터 거꾸로 센다. 한 주의 대상 날이 모두 달성이어야 그 주가 달성이다.
 * - 이번 주에 이미 못 한 날(오늘 전)이 있으면 0, 지난 주 이전에 못 한 날이 있으면 거기서 연속이 끊긴다
 * - 이번 주처럼 아직 남은 대상 날이 있는 주는 세지도 끊지도 않는다
 * - 대상 날이 전부 건너뛴 날인 주, 대상 날이 아예 없는 주도 세지도 끊지도 않는다
 * - since: 기록을 읽은 시작 날짜. 이 날 이전은 기록이 없는 것이지 못 한 것이 아니므로, 이 날부터 시작하는 온전한 주까지만 본다
 */
export function weeklyStreak(
    goal: GoalRule,
    today: string,
    study: ReadonlyMap<string, DayStudy>,
    skipDates: ReadonlySet<string>,
    since?: string,
): number {
    if (!goal.isActive) return 0;
    const thisWeek = weekStartOf(today);
    const start = since !== undefined && since > goal.createdDate ? since : goal.createdDate;
    let firstWeek = weekStartOf(start);
    if (since !== undefined && since > goal.createdDate && firstWeek < since) firstWeek = addDays(firstWeek, 7); // 잘린 주는 판정하지 않는다

    let streak = 0;
    let week = thisWeek;
    for (let i = 0; i < MAX_WEEKS && week >= firstWeek; i++, week = addDays(week, -7)) {
        const verdicts = Array.from({ length: 7 }, (_, d) => judgeDay(goal, addDays(week, d), today, study, skipDates));
        if (verdicts.includes('missed')) return week === thisWeek ? 0 : streak;
        if (verdicts.includes('pending')) continue; // 진행 중인 주
        if (verdicts.includes('achieved')) streak += 1; // 전부 건너뛴 주 · 대상 날이 없는 주는 여기서 넘어간다
    }
    return streak;
}
