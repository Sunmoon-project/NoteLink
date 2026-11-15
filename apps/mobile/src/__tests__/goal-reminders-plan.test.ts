import type { RecurringGoal } from '@notelink/shared';
import {
  DEFAULT_REMIND_TIME,
  GOAL_REMIND_KIND,
  MAX_REMINDERS,
  REMIND_HORIZON_DAYS,
  planReminders,
  reconcile,
  reminderId,
  remindTimeOf,
  type PlannedReminder,
} from '../features/progress/goal-reminders-plan';

// 서울 2026-11-14(토) 12:00. 이후 7일: 토 14 · 일 15 · 월 16 · 화 17 · 수 18 · 목 19 · 금 20
const NOW = Date.parse('2026-11-14T03:00:00Z');
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+09:00`);
const none = () => 0;

const goal = (over: Partial<RecurringGoal> = {}): RecurringGoal => ({
  _id: 'g1',
  name: '영어 단어',
  days: [6],
  targetMin: 60,
  subjectId: null,
  remindEnabled: true,
  remindTime: '21:00',
  pausedUntil: null,
  streak: 0,
  isActive: true,
  todayMin: 0,
  ...over,
});
const plan = (
  goals: RecurringGoal[],
  extra: { skip?: string[]; sessionSec?: (b: number, a: number) => number; now?: number } = {},
) =>
  planReminders({
    userId: 'u1',
    now: extra.now ?? NOW,
    goals,
    skipDates: new Set(extra.skip ?? []),
    sessionSec: extra.sessionSec ?? none,
  });
const dates = (list: PlannedReminder[]) => list.map((p) => p.data.date);

describe('반복 목표 리마인드 계획 (planReminders)', () => {
  it('오늘이 목표 요일이면 지정 시각에 "오늘 목표까지 O분 남았어요"를 예약한다', () => {
    const [r, ...rest] = plan([goal({ todayMin: 20 })]);
    expect(rest).toEqual([]);
    expect(r).toEqual({
      identifier: 'goal-remind.u1.g1.2026-11-14',
      title: '영어 단어',
      body: '오늘 목표까지 40분 남았어요',
      dueAt: at('2026-11-14', '21:00'),
      data: {
        kind: GOAL_REMIND_KIND,
        userId: 'u1',
        goalId: 'g1',
        date: '2026-11-14',
        dueAt: at('2026-11-14', '21:00'),
      },
    });
  });

  it('요일 번호는 서버와 같이 0=일 ... 6=토이고, 앞으로 7일만 본다', () => {
    expect(dates(plan([goal({ days: [0], todayMin: 0 })]))).toEqual(['2026-11-15']);
    expect(dates(plan([goal({ days: [1, 3], todayMin: null })]))).toEqual([
      '2026-11-16',
      '2026-11-18',
    ]);
    const everyDay = plan([goal({ days: [0, 1, 2, 3, 4, 5, 6] })]);
    expect(everyDay).toHaveLength(REMIND_HORIZON_DAYS);
    expect(dates(everyDay)[0]).toBe('2026-11-14');
    expect(dates(everyDay).at(-1)).toBe('2026-11-20');
  });

  it('오늘이 아닌 날은 아직 공부하지 않은 것으로 보고 목표 시간 전체를 남은 분으로 쓴다', () => {
    const list = plan([goal({ days: [6, 0, 1], targetMin: 45, todayMin: 30 })]);
    expect(list.map((p) => p.body)).toEqual([
      '오늘 목표까지 15분 남았어요',
      '오늘 목표까지 45분 남았어요',
      '오늘 목표까지 45분 남았어요',
    ]);
  });

  it('서버가 오늘을 판정 대상으로 보지 않으면(todayMin null) 오늘은 예약하지 않고 다른 날은 예약한다', () => {
    expect(dates(plan([goal({ days: [6, 0], todayMin: null })]))).toEqual(['2026-11-15']);
  });

  it('오늘 시각이 이미 지났으면 오늘은 예약하지 않는다(알릴 시각 정각도 지난 것으로 본다)', () => {
    expect(dates(plan([goal({ days: [6, 0], remindTime: '11:59' })]))).toEqual(['2026-11-15']);
    expect(dates(plan([goal({ days: [6], remindTime: '12:00' })]))).toEqual([]);
    expect(dates(plan([goal({ days: [6], remindTime: '12:01' })]))).toEqual(['2026-11-14']);
  });

  it('오늘 목표를 채웠으면 예약하지 않는다(달성)', () => {
    expect(plan([goal({ todayMin: 60 })])).toEqual([]);
    expect(plan([goal({ todayMin: 90 })])).toEqual([]);
    expect(plan([goal({ todayMin: 59 })])).toHaveLength(1);
  });

  it('정산 전 세션을 더한다: 알릴 시각까지 계속하면 목표를 채우는지 · 남은 분이 얼마인지', () => {
    const calls: [number, number][] = [];
    const running = (b: number, a: number) => {
      calls.push([b, a]);
      return 1800;
    };
    const [r] = plan([goal({ todayMin: 20 })], { sessionSec: running });
    expect(r!.body).toBe('오늘 목표까지 10분 남았어요'); // 60분 - 20분 - 30분
    // 세션 경계는 오늘 서울 자정, 끝은 알릴 시각
    expect(calls).toEqual([[at('2026-11-14', '00:00'), at('2026-11-14', '21:00')]]);
    expect(plan([goal({ todayMin: 20 })], { sessionSec: () => 2400 })).toEqual([]); // 20 + 40 = 60 → 달성
    // 세션은 오늘 몫만 센다: 다른 날의 남은 분은 그대로
    const week = plan([goal({ days: [6, 0], todayMin: 0 })], { sessionSec: () => 600 });
    expect(week.map((p) => p.body)).toEqual([
      '오늘 목표까지 50분 남았어요',
      '오늘 목표까지 60분 남았어요',
    ]);
  });

  it('남은 초가 분 단위가 아니면 올림한다(1초 남아도 1분)', () => {
    const [r] = plan([goal({ todayMin: 59 })], { sessionSec: () => 0 });
    expect(r!.body).toBe('오늘 목표까지 1분 남았어요');
    const [s] = plan([goal({ todayMin: 20 })], { sessionSec: () => 2399 });
    expect(s!.body).toBe('오늘 목표까지 1분 남았어요'); // 3600 - 1200 - 2399 = 1초
  });

  it('쉬는 목표 · 알림을 끈 목표는 예약하지 않는다', () => {
    expect(plan([goal({ isActive: false })])).toEqual([]);
    expect(plan([goal({ remindEnabled: false })])).toEqual([]);
  });

  it('일시 정지는 그 날(서울 날짜)까지 쉬고, 다음 날부터 다시 예약한다', () => {
    const everyDay = { days: [0, 1, 2, 3, 4, 5, 6], todayMin: 0 };
    // 서버는 'YYYY-MM-DD' 쉬는 날짜를 서울 자정 순간으로 저장해 ISO로 내려준다
    const list = plan([goal({ ...everyDay, pausedUntil: '2026-11-15T15:00:00.000Z' })]); // 서울 11-16까지
    expect(dates(list)).toEqual(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
  });

  it('공휴일 · 제외일은 예약하지 않는다 (숨긴 공휴일도 건너뛰는 서버 판정과 같다)', () => {
    const list = plan([goal({ days: [6, 0, 1], todayMin: 0 })], {
      skip: ['2026-11-14', '2026-11-16'],
    });
    expect(dates(list)).toEqual(['2026-11-15']);
  });

  it('remindTime이 비었거나 잘못되면 기본 21:00으로 예약한다', () => {
    expect(DEFAULT_REMIND_TIME).toBe('21:00');
    for (const remindTime of [null, '', '25:00', '9:00', 'abc']) {
      expect(remindTimeOf({ remindTime })).toBe('21:00');
      expect(plan([goal({ remindTime })])[0]!.dueAt).toBe(at('2026-11-14', '21:00'));
    }
    expect(plan([goal({ remindTime: '07:30', days: [0] })])[0]!.dueAt).toBe(
      at('2026-11-15', '07:30'),
    );
  });

  it('서울 날짜로 오늘을 정한다: UTC로는 아직 전날이어도 서울이 자정을 넘었으면 서울 날짜', () => {
    const now = Date.parse('2026-11-14T15:30:00Z'); // 서울 11-15(일) 00:30
    expect(dates(plan([goal({ days: [0], todayMin: 0 })], { now }))).toEqual(['2026-11-15']);
    // 토요일(11-14)은 이미 어제라 다음 토요일(11-21)만 남는다
    expect(dates(plan([goal({ days: [6], todayMin: 0 })], { now }))).toEqual(['2026-11-21']);
  });

  it('기기 시간대와 상관없이 서울 시각 그대로 울린다', () => {
    expect(plan([goal({ remindTime: '21:00' })])[0]!.dueAt).toBe(
      Date.parse('2026-11-14T12:00:00Z'),
    );
  });

  it(`예약은 울릴 순간이 이른 것부터 최대 ${MAX_REMINDERS}개다`, () => {
    const goals = Array.from({ length: 6 }, (_, i) =>
      goal({
        _id: `g${i}`,
        days: [0, 1, 2, 3, 4, 5, 6],
        remindTime: `${String(13 + i).padStart(2, '0')}:00`,
      }),
    );
    const list = plan(goals);
    expect(list).toHaveLength(MAX_REMINDERS); // 6 x 7 = 42 중 40
    const times = list.map((p) => p.dueAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // 가장 늦게 울리는 2개(마지막 날 · 가장 늦은 시각 쪽)가 잘린다
    expect(list.map((p) => p.identifier)).not.toContain(reminderId('u1', 'g5', '2026-11-20'));
    expect(list.map((p) => p.identifier)).toContain(reminderId('u1', 'g0', '2026-11-14'));
  });

  it('같은 입력이면 같은 계획이고 identifier는 목표 · 날짜마다 하나다', () => {
    const goals = [goal({ days: [6, 0] }), goal({ _id: 'g2', name: '독서', days: [6] })];
    expect(plan(goals)).toEqual(plan(goals));
    const ids = plan(goals).map((p) => p.identifier);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('이미 예약된 알림과 맞추기 (reconcile)', () => {
  const planned = plan([goal({ days: [6, 0], todayMin: 20 })]);
  const scheduledOf = (
    p: PlannedReminder,
    over: Partial<{ body: string; data: Record<string, unknown> }> = {},
  ) => ({
    identifier: p.identifier,
    body: over.body ?? p.body,
    data: over.data ?? { ...p.data },
  });

  it('같은 계획이 이미 예약돼 있으면 아무것도 하지 않는다', () => {
    expect(
      reconcile(
        planned,
        planned.map((p) => scheduledOf(p)),
        'u1',
      ),
    ).toEqual({ cancel: [], schedule: [] });
  });

  it('아무것도 없으면 계획 전부를 예약한다', () => {
    expect(reconcile(planned, [], 'u1')).toEqual({ cancel: [], schedule: planned });
  });

  it('본문(남은 분)이나 시각이 달라졌으면 취소하고 다시 예약한다', () => {
    const [first, second] = planned as [PlannedReminder, PlannedReminder];
    const result = reconcile(
      planned,
      [
        scheduledOf(first, { body: '오늘 목표까지 99분 남았어요' }),
        scheduledOf(second, { data: { ...second.data, dueAt: 1 } }),
      ],
      'u1',
    );
    expect(result.cancel.sort()).toEqual([first.identifier, second.identifier].sort());
    expect(result.schedule).toEqual(planned);
  });

  it('계획에 없는 예약(달성 · 목표 삭제 · 알림 끔)은 취소한다', () => {
    const stale = scheduledOf({ ...planned[0]!, identifier: 'goal-remind.u1.gone.2026-11-14' });
    expect(reconcile([], [stale], 'u1')).toEqual({
      cancel: ['goal-remind.u1.gone.2026-11-14'],
      schedule: [],
    });
  });

  it('다른 계정의 예약이거나 로그아웃(userId null)이면 모두 취소한다', () => {
    const mine = planned.map((p) => scheduledOf(p));
    const other = reconcile(planned, mine, 'someone-else');
    expect(other.cancel).toHaveLength(planned.length);
    expect(other.schedule).toEqual(planned);
    expect(reconcile([], mine, null).cancel).toHaveLength(planned.length);
  });

  it('주간 80% 알림 등 다른 종류는 건드리지 않는다', () => {
    const weekly = {
      identifier: 'w1',
      body: '이번 주 공부 목표의 80%를 달성했어요.',
      data: { kind: 'weekly-goal-80', userId: 'u1' },
    };
    const unknown = { identifier: 'x', body: null, data: null };
    expect(reconcile([], [weekly, unknown], 'u1')).toEqual({ cancel: [], schedule: [] });
    expect(reconcile([], [weekly, unknown], null)).toEqual({ cancel: [], schedule: [] });
  });
});
