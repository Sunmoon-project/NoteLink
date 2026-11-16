// 반복 목표 리마인드 푸시(FR-11-07 · 08) 단위 테스트: 시각 · 창 · 문구 · 설정 변경 규칙(순수 함수)과,
// 가짜 모델로 대상 고르기(요일 · 끔 · 일시정지 · 공휴일 · 이미 채움 · 시각 · 늦게 만든 목표)와 발송 문구를 본다.
// 실제 DB에서 서버 둘이 겹칠 때 · 실패 재시도 · 만료 토큰 삭제는 goal-reminders-real-db.test.ts
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { GoalRemindersService } from '../src/modules/progress/goal-reminders.service.js';
import {
  DEFAULT_REMIND_TIME,
  REMIND_MAX_ATTEMPTS,
  inRemindWindow,
  normalizeRemindTime,
  remindEnd,
  remindMessage,
  shouldSkipTodayAfterChange,
  weekdayOfDate,
} from '../src/modules/progress/goal-remind.js';

// 2026-11-16(월) 서울 기준 시각을 만든다
const seoul = (hhmm: string, day = '2026-11-16') => new Date(`${day}T${hhmm}:00+09:00`);
const TODAY = '2026-11-16';
const MON = 1;

describe('리마인드 시각 · 창', () => {
  it('시각이 없거나 형식이 틀리면 기본 21:00', () => {
    expect(DEFAULT_REMIND_TIME).toBe('21:00');
    expect(normalizeRemindTime(null)).toBe('21:00');
    expect(normalizeRemindTime(undefined)).toBe('21:00');
    expect(normalizeRemindTime('25:99')).toBe('21:00');
    expect(normalizeRemindTime('07:05')).toBe('07:05');
  });

  it('리마인드 시각부터 2시간 뒤까지가 창이다(시작 포함 · 끝 제외)', () => {
    expect(inRemindWindow(seoul('20:59'), TODAY, '21:00')).toBe(false);
    expect(inRemindWindow(seoul('21:00'), TODAY, '21:00')).toBe(true);
    expect(inRemindWindow(seoul('22:59'), TODAY, '21:00')).toBe(true);
    expect(inRemindWindow(seoul('23:00'), TODAY, '21:00')).toBe(false);
    expect(inRemindWindow(seoul('21:00'), TODAY, null)).toBe(true); // 기본 21:00
  });

  it('창은 서울 자정을 넘지 않는다', () => {
    expect(remindEnd(TODAY, '23:30').toISOString()).toBe(
      seoul('00:00', '2026-11-17').toISOString(),
    );
    expect(inRemindWindow(seoul('23:59'), TODAY, '23:30')).toBe(true);
    expect(inRemindWindow(seoul('00:00', '2026-11-17'), TODAY, '23:30')).toBe(false);
  });

  it('서울 날짜의 요일 번호 (0=일)', () => {
    expect(weekdayOfDate('2026-11-16')).toBe(MON);
    expect(weekdayOfDate('2026-11-15')).toBe(0);
  });
});

describe('푸시 문구', () => {
  it('제목에 남은 분, 본문에 목표 이름과 채운 분', () => {
    expect(remindMessage('영어 단어', 30, 12)).toEqual({
      title: '오늘 목표까지 18분 남았어요',
      body: '영어 단어 · 30분 중 12분을 채웠어요',
    });
    expect(remindMessage('수학', 60, 0).title).toBe('오늘 목표까지 60분 남았어요');
  });
});

describe('설정을 바꿀 때 오늘 리마인드를 건너뛸지 (FR-11-08)', () => {
  const base = { remindEnabled: true, remindTime: '21:00', days: [MON], isActive: true };
  const skip = (before: object, after: object, at: string) =>
    shouldSkipTodayAfterChange({ ...base, ...before }, { ...base, ...after }, seoul(at), TODAY);

  it('지난 시각으로 켜면 건너뛴다(켠 직후 바로 푸시가 가지 않게)', () => {
    expect(skip({ remindEnabled: false }, {}, '21:40')).toBe(true);
  });
  it('아직 안 지난 시각으로 켜면 건너뛰지 않는다', () => {
    expect(skip({ remindEnabled: false }, {}, '20:00')).toBe(false);
  });
  it('시각을 지난 시각으로 바꾸면 건너뛰고, 앞으로 바꾸면 건너뛰지 않는다', () => {
    expect(skip({ remindTime: '22:00' }, { remindTime: '21:00' }, '21:40')).toBe(true);
    expect(skip({ remindTime: '21:00' }, { remindTime: '23:00' }, '21:40')).toBe(false);
  });
  it('오늘 요일을 새로 넣거나 쉬던 목표를 다시 시작해도 같다', () => {
    expect(skip({ days: [2] }, {}, '21:40')).toBe(true);
    expect(skip({ isActive: false }, {}, '21:40')).toBe(true);
  });
  it('이름만 고치는 편집(설정 그대로)은 막지 않는다', () => {
    expect(skip({}, {}, '21:40')).toBe(false);
  });
  it('끄거나 오늘이 목표 요일이 아니면 건너뛸 것이 없다', () => {
    expect(skip({}, { remindEnabled: false }, '21:40')).toBe(false);
    expect(skip({ days: [MON] }, { days: [2] }, '21:40')).toBe(false);
  });
});

describe('GoalRemindersService 대상 고르기', () => {
  const userId = new Types.ObjectId();
  const goal = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    userId,
    name: '영어 단어',
    days: [MON],
    targetMin: 30,
    remindEnabled: true,
    remindTime: '21:00',
    isActive: true,
    deletedAt: null,
    pausedUntil: null,
    subjectId: null,
    lastRemindedOn: null,
    createdAt: seoul('09:00', '2026-11-01'),
    ...over,
  });

  function setup(opts: {
    goals: Record<string, unknown>[];
    totalSec?: number;
    skip?: string[];
    devices?: string[];
    send?: (messages: { to: string }[]) => unknown;
    deleteFails?: boolean;
  }) {
    const filters: Record<string, unknown>[] = [];
    const claims: unknown[] = [];
    const goals = {
      find: (filter: Record<string, unknown>) => {
        filters.push(filter);
        const chain = {
          sort: () => chain,
          limit: () => chain,
          lean: () => Promise.resolve(opts.goals),
        };
        return chain;
      },
      updateOne: (filter: unknown, update: unknown) => {
        claims.push({ filter, update });
        return Promise.resolve({ matchedCount: 1 });
      },
    };
    const daily = {
      find: () => ({
        lean: () =>
          Promise.resolve(
            opts.totalSec === undefined ? [] : [{ studyDate: TODAY, totalSec: opts.totalSec }],
          ),
      }),
    };
    const devices = {
      find: () => ({
        lean: () =>
          Promise.resolve(
            (opts.devices ?? ['ExponentPushToken[aaa]']).map((pushToken) => ({ pushToken })),
          ),
      }),
      deleteMany: vi.fn(() =>
        opts.deleteFails ? Promise.reject(new Error('db down')) : Promise.resolve(),
      ),
    };
    const holidays = { skipDates: () => Promise.resolve(opts.skip ?? []) };
    const push = {
      send: vi.fn(
        (messages: { to: string }[]) =>
          opts.send?.(messages) ?? Promise.resolve({ invalidTokens: [], failedTickets: [] }),
      ),
    };
    const service = new GoalRemindersService(
      goals as never,
      daily as never,
      devices as never,
      holidays as never,
      push as never,
    );
    return { service, push, filters, claims, devices };
  }

  it('요일 · 켬 · 쉬지 않음 · 안 지움 · 오늘 안 보냄을 조건으로 찾는다', async () => {
    const { service, filters } = setup({ goals: [] });
    await service.runOnce(seoul('21:05'));
    expect(filters[0]).toMatchObject({
      isActive: true,
      remindEnabled: true,
      deletedAt: null,
      days: MON,
      lastRemindedOn: { $ne: TODAY },
    });
    expect(REMIND_MAX_ATTEMPTS).toBe(3);
  });

  it('시각이 지났고 목표보다 적게 공부했으면 남은 분과 data 로 보낸다(채널은 비움)', async () => {
    const g = goal();
    const { service, push, claims } = setup({ goals: [g], totalSec: 12 * 60 + 59 });
    await service.runOnce(seoul('21:05'));
    expect(push.send).toHaveBeenCalledTimes(1);
    const [[messages]] = push.send.mock.calls as unknown as [[Record<string, unknown>[]]];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      to: 'ExponentPushToken[aaa]',
      title: '오늘 목표까지 18분 남았어요',
      body: '영어 단어 · 30분 중 12분을 채웠어요',
      data: { type: 'goal-remind', goalId: String(g._id) },
    });
    expect(messages[0]).not.toHaveProperty('channelId');
    expect(claims).toHaveLength(1); // 오늘 날짜로 표시를 잡았다
    expect(claims[0]).toMatchObject({ update: { $set: { lastRemindedOn: TODAY } } });
  });

  it('선점 조건에 후보를 읽을 때의 remindVersion 이 들어간다(필드가 없는 옛 목표는 0으로 본다)', async () => {
    const versioned = goal({ remindVersion: 3 });
    const legacy = goal();
    const { service, claims } = setup({ goals: [versioned, legacy] });
    await service.runOnce(seoul('21:05'));
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ filter: { _id: versioned._id, remindVersion: 3 } });
    expect(claims[1]).toMatchObject({ filter: { _id: legacy._id, remindVersion: { $in: [0, null] } } });
  });

  it('만료 토큰 삭제가 실패해도 발송은 성공으로 보고 표시를 풀지 않는다', async () => {
    const { service, push, claims, devices } = setup({
      goals: [goal()],
      deleteFails: true,
      send: () => ({ invalidTokens: ['ExponentPushToken[aaa]'], failedTickets: [] }),
    });
    await service.runOnce(seoul('21:05'));
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(devices.deleteMany).toHaveBeenCalledTimes(1);
    expect(claims).toHaveLength(1); // 선점 하나뿐, 표시를 푸는 쓰기(재시도 예약)가 없다
  });

  it('목표마다 선점 직전에 시계를 다시 보고, 서울 날짜가 바뀌었으면 남은 목표는 보내지 않는다', async () => {
    const a = goal({ remindTime: '23:00' });
    const b = goal({ remindTime: '23:00' });
    // 목표마다 선점 직전과 발송 직전에 한 번씩 읽는다(첫 목표 2번, 둘째 목표는 선점 직전에 자정을 넘김)
    const times = [seoul('23:59'), seoul('23:59'), seoul('00:00', '2026-11-17')];
    const clock = vi.fn(() => times.shift() ?? seoul('00:05', '2026-11-17'));
    const { service, push, claims } = setup({ goals: [a, b] });
    await service.runOnce(seoul('23:59'), clock);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ filter: { _id: a._id } });
  });

  it('발송 직전에 시계를 다시 읽어 발송 시간대(2시간)를 벗어났으면 보내지 않고 재시도 예약도 하지 않는다', async () => {
    const times = [seoul('22:59'), seoul('23:00')]; // 선점 직전은 창 안, 발송 직전은 21:00 목표의 창(23:00) 끝
    const clock = vi.fn(() => times.shift() ?? seoul('23:00'));
    const { service, push, claims } = setup({ goals: [goal()] });
    await service.runOnce(seoul('22:59'), clock);
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(1); // 선점만 있고 표시를 푸는 쓰기(재시도 예약)는 없다
  });

  it('공부를 아직 안 했으면 목표 전체가 남은 분이다', async () => {
    const { service, push } = setup({ goals: [goal({ targetMin: 45 })] });
    await service.runOnce(seoul('21:00'));
    const [[messages]] = push.send.mock.calls as unknown as [[{ title: string }[]]];
    expect(messages[0]!.title).toBe('오늘 목표까지 45분 남았어요');
  });

  it('리마인드 시각 전이나 창이 지난 뒤에는 잡지도 보내지도 않는다', async () => {
    const { service, push, claims } = setup({ goals: [goal()] });
    await service.runOnce(seoul('20:59'));
    await service.runOnce(seoul('23:00'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });

  it('리마인드 시각이 목표마다 다르다(없으면 21:00)', async () => {
    const { service, push } = setup({ goals: [goal({ remindTime: '19:30' })] });
    await service.runOnce(seoul('19:29'));
    expect(push.send).not.toHaveBeenCalled();
    await service.runOnce(seoul('19:30'));
    expect(push.send).toHaveBeenCalledTimes(1);
    const none = setup({ goals: [goal({ remindTime: null })] });
    await none.service.runOnce(seoul('20:59'));
    expect(none.push.send).not.toHaveBeenCalled();
    await none.service.runOnce(seoul('21:00'));
    expect(none.push.send).toHaveBeenCalledTimes(1);
  });

  it('이미 목표를 채웠으면 보내지 않고 표시만 남긴다', async () => {
    const { service, push, claims } = setup({ goals: [goal()], totalSec: 30 * 60 });
    await service.runOnce(seoul('21:05'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(1);
  });

  it('일시정지 중이거나 공휴일 · 제외일이면 보내지 않는다', async () => {
    const paused = setup({ goals: [goal({ pausedUntil: seoul('00:00', '2026-11-17') })] });
    await paused.service.runOnce(seoul('21:05'));
    expect(paused.push.send).not.toHaveBeenCalled();
    const holiday = setup({ goals: [goal()], skip: [TODAY] });
    await holiday.service.runOnce(seoul('21:05'));
    expect(holiday.push.send).not.toHaveBeenCalled();
  });

  it('리마인드 시각 이후에 만든 목표는 그날 건너뛴다', async () => {
    const { service, push, claims } = setup({
      goals: [goal({ createdAt: seoul('21:30') })],
    });
    await service.runOnce(seoul('21:40'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });

  it('과목 목표는 그 과목에서 쌓은 시간만 센다(기록에 그 과목이 없으면 0분)', async () => {
    const { service, push } = setup({
      goals: [goal({ subjectId: new Types.ObjectId() })],
      totalSec: 3600, // 다른 과목으로 한 시간 공부했어도 이 목표에는 0분
    });
    await service.runOnce(seoul('21:05'));
    const [[messages]] = push.send.mock.calls as unknown as [[{ title: string }[]]];
    expect(messages[0]!.title).toBe('오늘 목표까지 30분 남았어요');
  });

  it('기기가 없거나 푸시 토큰 형식이 아니면 보내지 않고 표시만 남긴다', async () => {
    const none = setup({ goals: [goal()], devices: [] });
    await none.service.runOnce(seoul('21:05'));
    expect(none.push.send).not.toHaveBeenCalled();
    expect(none.claims).toHaveLength(1);
    const bad = setup({ goals: [goal()], devices: ['not-a-token'] });
    await bad.service.runOnce(seoul('21:05'));
    expect(bad.push.send).not.toHaveBeenCalled();
  });

  it('다시 시도 시각 전인 목표는 건너뛴다', async () => {
    const { service, push, claims } = setup({
      goals: [goal({ remindRetryAt: seoul('21:10'), remindAttempts: 1, remindAttemptsOn: TODAY })],
    });
    await service.runOnce(seoul('21:05'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });
});
