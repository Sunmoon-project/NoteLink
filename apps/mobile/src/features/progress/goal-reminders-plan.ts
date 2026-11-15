import type { RecurringGoal } from '@notelink/shared';
import { addDays, parse, seoul, ymd } from '@/lib/dates';

// 반복 목표 리마인드 알림 계획 (FR-11-07 · 08). 순수 함수: 시계 · 저장소 · 알림 API를 읽지 않고 받은 값만으로 계산한다.
// 날짜는 모두 서울 기준 'YYYY-MM-DD'. 요일 번호는 서버와 같이 0=일 ... 6=토.

/** 알림 종류. 주간 목표 80% 알림('weekly-goal-80')과 구분하려고 data.kind에 넣는다 */
export const GOAL_REMIND_KIND = 'goal-remind';
/** 오늘부터 며칠치를 미리 예약할지(앱을 안 열어도 오게). 앱을 열 때마다 다시 계획해 하루씩 밀린다 */
export const REMIND_HORIZON_DAYS = 7;
/** 이 기능이 한 번에 잡아 둘 예약 수. iOS는 앱당 예약이 64개까지라 주간 80% 알림 등을 위해 남겨 둔다 */
export const MAX_REMINDERS = 40;
/** 서버 기본값과 같다(요구사항 "기본 21시") */
export const DEFAULT_REMIND_TIME = '21:00';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 예약해 둘 알림 하나. data.dueAt · body로 이미 예약된 것과 같은지 비교한다 */
export interface PlannedReminder {
  /** 목표 · 날짜마다 고정이라 같은 계획을 몇 번 예약해도 하나다 */
  identifier: string;
  title: string;
  body: string;
  /** 울릴 순간(ms) */
  dueAt: number;
  data: {
    kind: typeof GOAL_REMIND_KIND;
    userId: string;
    goalId: string;
    date: string;
    dueAt: number;
  };
}

export interface PlanInput {
  userId: string;
  now: number;
  goals: RecurringGoal[];
  /** 건너뛸 날: 공휴일(내가 캘린더에서 숨긴 것도 포함 — 서버 판정이 건너뛴다)과 내 제외일 */
  skipDates: ReadonlySet<string>;
  /**
   * 지금 도는 공부 세션이 [boundary, at] 안에서 쌓는 초(서버에 아직 정산되지 않은 몫).
   * useSession().elapsedSince(boundary, at)을 넘기면 지금 돌고 있는 상태로 at까지 계속한다고 보고 센다
   */
  sessionSec: (boundary: number, at: number) => number;
}

export const reminderId = (userId: string, goalId: string, date: string) =>
  `${GOAL_REMIND_KIND}.${userId}.${goalId}.${date}`;

/** 서울 'YYYY-MM-DD'와 'HH:mm'이 가리키는 순간(ms) */
const instant = (date: string, time: string) => Date.parse(`${date}T${time}:00+09:00`);

/** 잘못된 값 · 비어 있는 값이면 기본 21:00 */
export const remindTimeOf = (goal: Pick<RecurringGoal, 'remindTime'>): string =>
  goal.remindTime && HHMM.test(goal.remindTime) ? goal.remindTime : DEFAULT_REMIND_TIME;

/**
 * 앞으로 예약할 알림. 한 목표 · 한 날짜에 하나이고, 울릴 순간이 이른 것부터 MAX_REMINDERS개까지.
 * - 쉬는 목표 · 알림 꺼짐 · 목표 요일 아님 · 일시 정지 중 · 공휴일/제외일 · 이미 지난 시각은 제외
 * - 오늘: 서버가 알려준 todayMin이 null이면(서버가 오늘을 판정 대상으로 보지 않음) 제외. 오늘 센 시간에
 *   정산 전 세션을 더해, 알릴 시각까지 목표를 채우면 제외하고 아니면 남은 분을 본문에 쓴다
 * - 오늘이 아닌 날: 아직 공부하지 않은 것으로 보고 목표 시간 전체가 남았다고 쓴다(공부하면 앱이 다시 계획한다)
 */
export function planReminders(input: PlanInput): PlannedReminder[] {
  const { userId, now, goals, skipDates, sessionSec } = input;
  const today = ymd(seoul(now));
  const todayStart = instant(today, '00:00');
  const plan: PlannedReminder[] = [];
  for (const goal of goals) {
    if (!goal.isActive || !goal.remindEnabled) continue;
    const time = remindTimeOf(goal);
    const pausedThrough = goal.pausedUntil ? ymd(seoul(goal.pausedUntil)) : null;
    for (let i = 0; i < REMIND_HORIZON_DAYS; i++) {
      const date = ymd(addDays(parse(today), i));
      if (!goal.days.includes(parse(date).getDay())) continue;
      if (skipDates.has(date) || (pausedThrough !== null && date <= pausedThrough)) continue;
      const dueAt = instant(date, time);
      if (dueAt <= now) continue;
      let remainingMin = goal.targetMin;
      if (i === 0) {
        if (goal.todayMin == null) continue;
        const studiedSec = goal.todayMin * 60 + sessionSec(todayStart, dueAt);
        remainingMin = Math.ceil((goal.targetMin * 60 - studiedSec) / 60);
      }
      if (remainingMin <= 0) continue;
      plan.push({
        identifier: reminderId(userId, goal._id, date),
        title: goal.name,
        body: `오늘 목표까지 ${remainingMin}분 남았어요`,
        dueAt,
        data: { kind: GOAL_REMIND_KIND, userId, goalId: goal._id, date, dueAt },
      });
    }
  }
  return plan
    .sort((a, b) => a.dueAt - b.dueAt || (a.identifier < b.identifier ? -1 : 1))
    .slice(0, MAX_REMINDERS);
}

/** 이미 예약된 알림(getAllScheduledNotificationsAsync의 한 건)과 계획을 맞춰, 지울 것과 새로 예약할 것을 가린다 */
export interface ScheduledReminder {
  identifier: string;
  body: string | null;
  data: Record<string, unknown> | null;
}

export function reconcile(
  plan: PlannedReminder[],
  scheduled: ScheduledReminder[],
  userId: string | null,
): { cancel: string[]; schedule: PlannedReminder[] } {
  const wanted = new Map(plan.map((p) => [p.identifier, p]));
  const cancel: string[] = [];
  const keep = new Set<string>();
  for (const s of scheduled) {
    if (s.data?.['kind'] !== GOAL_REMIND_KIND) continue; // 주간 80% 등 다른 알림은 건드리지 않는다
    const p = wanted.get(s.identifier);
    const same =
      !!p && s.data['userId'] === userId && s.data['dueAt'] === p.dueAt && s.body === p.body;
    if (same) keep.add(s.identifier);
    else cancel.push(s.identifier);
  }
  return { cancel, schedule: plan.filter((p) => !keep.has(p.identifier)) };
}
