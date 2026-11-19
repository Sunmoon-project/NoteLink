// 복습 알림(FR-37-08) 단위 테스트: 가짜 모델로 보내는 시각 · 집계 한 번 · 대상 제외(오늘의 복습을 만든 사용자 · 탈퇴 중 · 탈퇴 ·
// 기기 없음) · 문구 · 발송 직전 재확인(날짜 · 복습할 문제 수) · 재시작 뒤 걸러내기 · 재시도 · 기록 실패 처리를 본다.
// 실제 DB의 집계 조건 · 서버 둘 동시 · 이어받기 · 색인은 review-reminders-real-db.test.ts
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  REVIEW_REMIND_LEASE_MS,
  REVIEW_REMIND_MAX_ATTEMPTS,
  REVIEW_REMIND_PAGE,
  REVIEW_REMIND_TIME,
  dayEnd,
  inRemindWindow,
  remindMessage,
  remindStart,
} from '../src/review-reminders/review-remind.js';
import { ReviewRemindersService } from '../src/review-reminders/review-reminders.service.js';

const DAY = '2026-11-17'; // 화요일
const seoul = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+09:00`);
const NOW = seoul('19:30');
const NEXT_DAY = '2026-11-18';
const TOKEN = 'ExponentPushToken[aaa]';

type Write = { filter: Record<string, unknown>; update: Record<string, unknown>; options?: object };

interface Opts {
  /** 하루 한 번 집계가 돌려주는 사용자(복습할 문제 수 포함) */
  due?: { userId: Types.ObjectId; due: number }[];
  /** 보내기 직전에 다시 센 복습할 문제 수(사용자별, 없으면 집계 값 그대로) */
  recount?: Map<string, number>;
  /** 오늘의 복습 세트를 이미 만든 사용자 */
  hasSet?: Set<string>;
  /** 사용자 문서(없는 사용자는 null) */
  users?: Map<string, { deletedAt?: Date | null; withdrawingAt?: Date | null } | null>;
  /** 이미 끝난 표시(review_reminders)가 있는 사용자 */
  finals?: Set<string>;
  devices?: string[];
  /** 선점 호출마다 성공(true) / 문서 없음(false) / 중복 키 오류(dup). 모자라면 true */
  claimResults?: (true | false | 'dup')[];
  /** 선점 응답의 실제 시도 횟수(기본 1) */
  claimedAttempts?: number;
  send?: () => unknown;
  deleteFails?: boolean;
  recheck?: object | null;
  /** 보내기 직전 선점 조회의 결과를 호출 차례대로(null 은 선점을 잃음). 모자라면 내 선점이 그대로 */
  rechecks?: (object | null)[];
  /** 선점을 잃었거나 못 잡은 사용자의 문서 읽기(holderWait) 결과를 호출 차례대로 */
  stateDocs?: (object | null)[];
  /** n번째 정리(updateMany) 호출에서 그 사용자들이 끝난 상태(gave_up)가 된다 */
  closeOnCleanup?: { call: number; users: string[] };
  /** 보내기 직전 선점 조회를 기다리는 사이 날짜가 바뀐다 */
  lateAfterRecheck?: boolean;
  aggregateFails?: number;
  /** 이 상태를 쓰는 updateOne 을 앞에서부터 times 번 실패시킨다 */
  failWrite?: { state: string | null; times: number };
  /** 기기를 읽은 뒤(발송 직전 확인 전에) 날짜가 바뀐다 */
  lateAfterDevices?: boolean;
}

const id = (n: number) => new Types.ObjectId(n.toString(16).padStart(24, '0'));

function setup(opts: Opts = {}) {
  const due = opts.due ?? [{ userId: id(1), due: 3 }];
  const aggregates: unknown[][] = [];
  const writes: Write[] = [];
  const cleanups: Write[] = [];
  const finals = opts.finals ?? new Set<string>();
  const state = { late: false };
  const recheckFilters: Record<string, unknown>[] = [];
  let recheckCalls = 0;
  let stateCalls = 0;
  let cleanupCalls = 0;
  let claimCalls = 0;
  let aggregateFailed = 0;
  let failed = 0;

  const sets = {
    aggregate: vi.fn((pipeline: { $match?: { ownerId?: Types.ObjectId } }[]) => {
      aggregates.push(pipeline);
      const owner = pipeline[0]?.$match?.ownerId;
      if (!owner) {
        if (aggregateFailed < (opts.aggregateFails ?? 0)) {
          aggregateFailed += 1;
          return Promise.reject(new Error('db down'));
        }
        return Promise.resolve(due.map((d) => ({ _id: d.userId, due: d.due })));
      }
      const row = due.find((d) => String(d.userId) === String(owner));
      const n = opts.recount?.get(String(owner)) ?? row?.due ?? 0;
      return Promise.resolve(n > 0 ? [{ _id: owner, due: n }] : []);
    }),
    exists: vi.fn((filter: { ownerId: Types.ObjectId }) =>
      Promise.resolve(opts.hasSet?.has(String(filter.ownerId)) ? { _id: id(999) } : null),
    ),
  };
  const reminders = {
    find: vi.fn((filter: Record<string, unknown>) => ({
      lean: () => {
        const ids = ((filter['userId'] as { $in?: Types.ObjectId[] })?.$in ?? []).filter((u) =>
          finals.has(String(u)),
        );
        return Promise.resolve(ids.map((userId) => ({ userId })));
      },
    })),
    findOneAndUpdate: vi.fn((filter: Write['filter'], update: Write['update'], options: object) => {
      writes.push({ filter, update, options });
      const result = opts.claimResults?.[claimCalls++] ?? true;
      return {
        lean: () => {
          if (result === 'dup')
            return Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }));
          return Promise.resolve(result ? { attempts: opts.claimedAttempts ?? 1 } : null);
        },
      };
    }),
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      lean: () => {
        if ('claimId' in filter) {
          // 보내기 직전: 내 선점이 그대로인지
          recheckFilters.push(filter);
          if (opts.lateAfterRecheck) state.late = true;
          if (opts.rechecks) {
            const at = recheckCalls++;
            return Promise.resolve(
              at < opts.rechecks.length ? opts.rechecks[at] : { state: 'claimed' },
            );
          }
          return Promise.resolve(opts.recheck === undefined ? { state: 'claimed' } : opts.recheck);
        }
        // 선점을 잃었거나 못 잡은 사용자의 문서 읽기(holderWait)
        return Promise.resolve(opts.stateDocs?.[stateCalls++] ?? null);
      },
    })),
    updateOne: vi.fn((filter: Write['filter'], update: Write['update'], options: object) => {
      writes.push({ filter, update, options });
      const set = (update['$set'] ?? {}) as Record<string, unknown>;
      const target = opts.failWrite;
      if (target && failed < target.times && set['state'] === target.state) {
        failed += 1;
        return Promise.reject(new Error('db down'));
      }
      if (['sent', 'skipped', 'gave_up'].includes(String(set['state']))) {
        finals.add(String(filter['userId']));
      }
      return Promise.resolve({ matchedCount: 1 });
    }),
    updateMany: vi.fn((filter: Write['filter'], update: Write['update'], options: object) => {
      cleanups.push({ filter, update, options });
      cleanupCalls += 1;
      if (opts.closeOnCleanup?.call === cleanupCalls) {
        for (const u of opts.closeOnCleanup.users) finals.add(u);
      }
      return Promise.resolve({ modifiedCount: 0 });
    }),
  };
  const devices = {
    find: vi.fn(() => ({
      lean: () => {
        if (opts.lateAfterDevices) state.late = true;
        return Promise.resolve((opts.devices ?? [TOKEN]).map((pushToken) => ({ pushToken })));
      },
    })),
    deleteMany: vi.fn(() =>
      opts.deleteFails ? Promise.reject(new Error('db down')) : Promise.resolve(),
    ),
  };
  const users = {
    findOne: vi.fn((filter: { _id: Types.ObjectId }) => ({
      lean: () => {
        const row = opts.users?.get(String(filter._id));
        return Promise.resolve(row === undefined ? { deletedAt: null, withdrawingAt: null } : row);
      },
    })),
  };
  const push = {
    send: vi.fn(() => opts.send?.() ?? Promise.resolve({ invalidTokens: [], failedTickets: [] })),
  };
  const makeService = () => {
    const service = new ReviewRemindersService(
      sets as never,
      reminders as never,
      devices as never,
      users as never,
      push as never,
      { pushAllowed: (ids: unknown[]) => Promise.resolve(ids) } as never,
    );
    // 기록 재시도 사이의 기다림은 테스트에서 실제로 기다리지 않는다
    const waits: number[] = [];
    service.recordWait = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    return { service, waits };
  };
  const { service, waits } = makeService();
  const clock = (at: Date, later?: Date) => () => (state.late && later ? later : at);
  const states = () =>
    writes
      .map((w) => (w.update['$set'] as Record<string, unknown> | undefined)?.['state'])
      .filter((s) => s !== undefined);
  const sentWrites = () =>
    writes.filter((w) => (w.update['$set'] as Record<string, unknown>)?.['state'] === 'sent');
  return {
    service,
    makeService,
    waits,
    sets,
    reminders,
    devices,
    users,
    push,
    aggregates,
    writes,
    cleanups,
    finals,
    clock,
    states,
    sentWrites,
    recheckFilters,
  };
}

const failAll = () =>
  Promise.resolve({
    invalidTokens: [],
    failedTickets: [{ message: { to: TOKEN }, error: 'x' }],
  });

describe('시각 · 문구(순수 함수)', () => {
  it('보내는 시각은 19:00(서울)이고, 그날 서울 자정 전까지만 보낼 수 있다', () => {
    expect(REVIEW_REMIND_TIME).toBe('19:00');
    expect(inRemindWindow(seoul('18:59'), DAY)).toBe(false);
    expect(inRemindWindow(seoul('19:00'), DAY)).toBe(true);
    expect(inRemindWindow(seoul('23:59'), DAY)).toBe(true);
    expect(inRemindWindow(seoul('00:00', NEXT_DAY), DAY)).toBe(false);
    expect(remindStart(DAY).toISOString()).toBe('2026-11-17T10:00:00.000Z');
    expect(dayEnd(DAY).toISOString()).toBe('2026-11-17T15:00:00.000Z'); // 서울 0시(UTC 15:00)
  });

  it('문구: 제목 고정, 본문은 문제 수(최대 5개)', () => {
    expect(remindMessage(3)).toEqual({
      title: '오늘 복습할 문제가 있어요',
      body: '복습할 문제 3개가 기다리고 있어요',
    });
    expect(remindMessage(12).body).toBe('복습할 문제 5개가 기다리고 있어요');
    expect(remindMessage(0).body).toBe('복습할 문제 1개가 기다리고 있어요');
  });
});

describe('보내는 시각 · 집계는 하루 한 번', () => {
  it('19:00 전에는 DB를 읽지도 보내지도 않는다', async () => {
    const { service, sets, reminders, push } = setup();
    await service.runOnce(seoul('18:59'));
    expect(sets.aggregate).not.toHaveBeenCalled();
    expect(reminders.find).not.toHaveBeenCalled();
    expect(push.send).not.toHaveBeenCalled();
  });

  it('19:00 이후 첫 확인에서 한 번 집계하고, 같은 날 다시 확인해도 집계하지 않는다', async () => {
    const { service, sets, aggregates } = setup();
    await service.runOnce(seoul('19:00'));
    await service.runOnce(seoul('19:01'));
    await service.runOnce(seoul('21:00'));
    const daily = aggregates.filter(
      (p) => !(p[0] as { $match: { ownerId?: unknown } }).$match.ownerId,
    );
    expect(daily).toHaveLength(1);
    expect(sets.aggregate.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('집계 조건: 지우지 않은 ready 세트 · 노트 있음 · active 이고 서울 내일 0시 전이 복습 날짜 · 결함 표시 없음', async () => {
    const { service, aggregates } = setup();
    await service.runOnce(NOW);
    const [match, unwind, match2, group] = aggregates[0] as Record<
      string,
      Record<string, unknown>
    >[];
    const tomorrow = dayEnd(DAY);
    expect(match!['$match']).toMatchObject({
      deletedAt: null,
      status: 'ready',
      materialId: { $ne: null },
      questions: { $elemMatch: { 'srs.state': 'active', 'srs.dueAt': { $lt: tomorrow } } },
    });
    expect(unwind).toEqual({ $unwind: '$questions' });
    expect(match2!['$match']).toMatchObject({
      'questions.srs.state': 'active',
      'questions.srs.dueAt': { $lt: tomorrow },
      'questions.srs.flaw': { $exists: false },
    });
    expect(group!['$group']).toMatchObject({ _id: '$ownerId' });
  });

  it('집계가 실패하면 다음 확인에서 다시 집계한다', async () => {
    const { service, push, aggregates } = setup({ aggregateFails: 1 });
    // 운영에서는 스케줄러가 이 오류를 잡아 로그만 남기고 다음 확인에서 다시 한다
    await expect(service.runOnce(NOW)).rejects.toThrow('db down');
    expect(push.send).not.toHaveBeenCalled();
    await service.runOnce(seoul('19:31'));
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(
      aggregates.filter((p) => !(p[0] as { $match: { ownerId?: unknown } }).$match.ownerId),
    ).toHaveLength(2);
  });
});

describe('날짜가 바뀌면 그날 것은 보내지 않는다', () => {
  it('서울 자정이 지나면 전날 집계 목록을 버리고, 새 날 19:00 전에는 아무것도 하지 않으며, 19:00 이후 다시 집계한다', async () => {
    const { service, sets, push } = setup({
      due: [{ userId: id(1), due: 3 }],
      claimResults: [false], // 첫날은 다른 서버가 잡아 보내지 않았다
    });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    const before = sets.aggregate.mock.calls.length;
    await service.runOnce(seoul('00:00', NEXT_DAY));
    await service.runOnce(seoul('18:59', NEXT_DAY));
    expect(sets.aggregate.mock.calls.length).toBe(before);
    expect(push.send).not.toHaveBeenCalled();
    await service.runOnce(seoul('19:00', NEXT_DAY));
    expect(sets.aggregate.mock.calls.length).toBeGreaterThan(before);
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('발송 직전에 서울 날짜가 바뀌었으면 보내지 않고 기록하지도 않는다', async () => {
    const { service, push, states, clock } = setup({ lateAfterDevices: true });
    await service.runOnce(undefined, clock(seoul('23:59'), seoul('00:00', NEXT_DAY)));
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed']);
  });
});

describe('대상: 복습할 문제가 있는 사용자만(오늘의 복습과 같은 기준)', () => {
  it('집계에 나온 사용자에게 문구 · data · collapseId 로 보낸다(channelId 는 넣지 않는다)', async () => {
    const { service, push, writes } = setup({ due: [{ userId: id(1), due: 12 }] });
    await service.runOnce(NOW);
    const [messages] = push.send.mock.calls[0] as unknown as [Record<string, unknown>[]];
    expect(messages[0]).toMatchObject({
      to: TOKEN,
      title: '오늘 복습할 문제가 있어요',
      body: '복습할 문제 5개가 기다리고 있어요',
      data: { type: 'today-review' },
      sound: 'default',
      priority: 'high',
      collapseId: `today-review:${DAY}:${String(id(1))}`,
    });
    expect(messages[0]).not.toHaveProperty('channelId');
    expect((writes[0]!.update['$set'] as Record<string, unknown>)['state']).toBe('claimed');
  });

  it('선점은 (userId, day) 조건의 upsert 이고 증가된 문서를 돌려받는다', async () => {
    const { service, writes } = setup();
    await service.runOnce(NOW);
    expect(writes[0]!.filter).toMatchObject({ userId: id(1), day: DAY });
    expect(writes[0]!.options).toMatchObject({ upsert: true, returnDocument: 'after' });
    expect(writes[0]!.update['$inc']).toEqual({ attempts: 1 });
  });

  it('오늘의 복습 세트를 이미 만든 사용자는 보내지 않고 skipped 로 끝낸다', async () => {
    const { service, push, states, sets } = setup({ hasSet: new Set([String(id(1))]) });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed', 'skipped']);
    expect(sets.exists).toHaveBeenCalledWith({ ownerId: id(1), reviewDay: DAY, deletedAt: null });
  });

  it('집계 뒤 보내기 직전에 다시 세어 복습할 문제가 없어졌으면(지운 세트 · 다 익힘 · 넘김) 보내지 않는다', async () => {
    const { service, push, states } = setup({ recount: new Map([[String(id(1)), 0]]) });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed', 'skipped']);
  });

  it.each([
    ['탈퇴 중', { deletedAt: null, withdrawingAt: new Date('2026-11-17T01:00:00Z') }],
    ['탈퇴한(삭제된)', { deletedAt: new Date('2026-11-16T01:00:00Z'), withdrawingAt: null }],
    ['없는', null],
  ])('%s 사용자는 보내지 않고 skipped 로 끝낸다', async (_name, user) => {
    const { service, push, states } = setup({ users: new Map([[String(id(1)), user]]) });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed', 'skipped']);
  });

  it('기기가 없는 사용자는 조용히 건너뛴다(skipped)', async () => {
    const { service, push, states } = setup({ devices: [] });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed', 'skipped']);
  });

  it('푸시 토큰 형식이 아닌 기기만 있어도 건너뛴다', async () => {
    const { service, push, states } = setup({ devices: ['not-a-token'] });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed', 'skipped']);
  });

  it('한 번에 REVIEW_REMIND_PAGE 명씩 처리하고 나머지는 다음 확인에서 처리한다', async () => {
    const due = Array.from({ length: REVIEW_REMIND_PAGE + 5 }, (_, i) => ({
      userId: id(i + 1),
      due: 2,
    }));
    const { service, push } = setup({ due });
    await service.runOnce(NOW);
    expect(push.send).toHaveBeenCalledTimes(REVIEW_REMIND_PAGE);
    await service.runOnce(seoul('19:31'));
    expect(push.send).toHaveBeenCalledTimes(REVIEW_REMIND_PAGE + 5);
  });
});

describe('하루 한 번 · 서버 재시작', () => {
  it('이미 끝난 표시(review_reminders)가 있는 사용자는 선점도 발송도 하지 않는다', async () => {
    const { service, push, reminders } = setup({ finals: new Set([String(id(1))]) });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(reminders.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('서버가 19:00 이후에 재시작하면 다시 집계하지만, 이미 보낸 사용자는 review_reminders 로 걸러져 한 번만 간다', async () => {
    const { service, makeService, push, sets } = setup({
      due: [
        { userId: id(1), due: 3 },
        { userId: id(2), due: 1 },
      ],
    });
    await service.runOnce(NOW);
    expect(push.send).toHaveBeenCalledTimes(2);
    const aggregatedBefore = sets.aggregate.mock.calls.length;
    // 재시작: 메모리의 집계 목록이 없는 새 서비스
    const { service: restarted } = makeService();
    await restarted.runOnce(seoul('20:10'));
    expect(sets.aggregate.mock.calls.length).toBeGreaterThan(aggregatedBefore); // 다시 집계했다
    expect(push.send).toHaveBeenCalledTimes(2); // 둘 다 이미 끝나 더 보내지 않았다
  });

  it('다른 서버가 이미 선점했으면(문서 없음 · 중복 키 오류) 보내지 않는다', async () => {
    for (const result of [false, 'dup'] as const) {
      const { service, push, states } = setup({ claimResults: [result] });
      await service.runOnce(NOW);
      expect(push.send).not.toHaveBeenCalled();
      expect(states()).toEqual(['claimed']); // 선점 시도만 있었다
    }
  });

  it('선점을 못 한 사용자는 한 번의 확인 간격(1분) 뒤에 다시 시도한다(그 전에는 건드리지 않는다)', async () => {
    const { service, push, reminders } = setup({ claimResults: [false, true] });
    await service.runOnce(NOW);
    await service.runOnce(new Date(NOW.getTime() + 30_000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(1);
    await service.runOnce(new Date(NOW.getTime() + 61_000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('선점 뒤 내 선점이 사라졌으면(다른 서버가 이어받음) 보내지 않고 아무것도 쓰지 않는다', async () => {
    const { service, push, states } = setup({ recheck: null });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed']);
  });
});

describe('발송 결과 · 재시도', () => {
  it('만료 토큰 삭제가 실패해도 발송은 성공으로 기록한다(재발송하지 않는다)', async () => {
    const { service, states } = setup({
      deleteFails: true,
      devices: ['ExponentPushToken[bad]', TOKEN],
      send: () => Promise.resolve({ invalidTokens: ['ExponentPushToken[bad]'], failedTickets: [] }),
    });
    await service.runOnce(NOW);
    expect(states()).toEqual(['claimed', 'sent']);
  });

  it('보낼 기기가 있는데 전부 실패하면 선점을 풀고 2분 뒤로 다시 시도를 예약한다', async () => {
    const { service, writes } = setup({ send: failAll });
    await service.runOnce(NOW);
    const release = writes.at(-1)!.update['$set'] as Record<string, unknown>;
    expect(release['state']).toBeNull();
    expect(release['retryAt']).toEqual(new Date(NOW.getTime() + 2 * 60_000));
  });

  it('풀린 사용자는 다시 시도 시각 전에는 선점하지 않고, 그 시각이 지나면 다시 보낸다', async () => {
    const { service, push, reminders } = setup({ send: failAll });
    await service.runOnce(NOW);
    await service.runOnce(new Date(NOW.getTime() + 60_000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(1);
    await service.runOnce(new Date(NOW.getTime() + 3 * 60_000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(push.send).toHaveBeenCalledTimes(2);
  });

  it('선점 응답의 실제 시도 횟수가 한도면(후보를 읽은 뒤 다른 서버가 올렸어도) 실패 시 gave_up 으로 기록한다', async () => {
    const { service, states } = setup({
      claimedAttempts: REVIEW_REMIND_MAX_ATTEMPTS,
      send: failAll,
    });
    await service.runOnce(NOW);
    expect(states()).toEqual(['claimed', 'gave_up']);
  });

  it('발송 중 오류는 선점을 풀어 다시 시도를 예약한다(기록 오류와 다르다)', async () => {
    const { service, writes } = setup({ send: () => Promise.reject(new Error('network')) });
    await service.runOnce(NOW);
    expect((writes.at(-1)!.update['$set'] as Record<string, unknown>)['state']).toBeNull();
  });
});

describe('발송 성공 뒤 기록 실패는 다시 보내지 않는다', () => {
  it('sent 기록이 한 번 실패해도 푸시는 1번이고, 선점을 풀지 않고 sent 만 다시 쓴다', async () => {
    const { service, push, states, waits } = setup({ failWrite: { state: 'sent', times: 1 } });
    await service.runOnce(NOW);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(states()).toEqual(['claimed', 'sent', 'sent']);
    expect(states()).not.toContain(null);
    expect(waits).toEqual([200]);
  });

  it('모두 실패하면 대기는 0.2초 · 0.5초이고 푸시는 1번(선점은 그대로)', async () => {
    const { service, push, states, waits } = setup({ failWrite: { state: 'sent', times: 3 } });
    await service.runOnce(NOW);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([200, 500]);
    expect(states()).toEqual(['claimed', 'sent', 'sent', 'sent']);
  });

  it('끝내 기록하지 못한 sent 는 다음 확인에서 먼저 다시 쓰고(claimId 조건 유지), 푸시는 늘어나지 않는다', async () => {
    const { service, push, writes, sentWrites } = setup({ failWrite: { state: 'sent', times: 3 } });
    await service.runOnce(NOW);
    const claimId = (writes[0]!.update['$set'] as Record<string, unknown>)['claimId'];
    await service.runOnce(new Date(NOW.getTime() + 60_000));
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(sentWrites().at(-1)!.filter).toMatchObject({ userId: id(1), day: DAY, claimId });
    expect(sentWrites()).toHaveLength(4);
    await service.runOnce(new Date(NOW.getTime() + 90_000));
    expect(sentWrites()).toHaveLength(4); // 한 번 다시 썼으면 더는 들고 있지 않는다
  });

  it('선점 만료(2분)가 지난 기록분은 다시 쓰지 않고 버린다', async () => {
    const { service, push, sentWrites } = setup({ failWrite: { state: 'sent', times: 3 } });
    await service.runOnce(NOW);
    await service.runOnce(new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS + 1000));
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(sentWrites()).toHaveLength(3);
  });

  it('보관 개수 상한을 넘으면 오래된 것부터 버린다', async () => {
    const due = [1, 2, 3].map((n) => ({ userId: id(n), due: 2 }));
    const { service, writes, sentWrites } = setup({ due, failWrite: { state: 'sent', times: 9 } });
    service.unrecordedLimit = 2;
    await service.runOnce(NOW);
    const before = writes.length;
    await service.runOnce(new Date(NOW.getTime() + 30_000));
    const rewritten = sentWrites()
      .filter((w) => writes.indexOf(w) >= before)
      .map((w) => String(w.filter['userId']));
    expect(new Set(rewritten)).toEqual(new Set([String(id(2)), String(id(3))]));
  });

  it('서버가 꺼질 때(onModuleDestroy) 보관한 기록분을 정리한다', async () => {
    const { service, writes, sentWrites } = setup({
      failWrite: { state: 'sent', times: 3 },
      claimResults: [true, 'dup'], // 재시작 뒤에도 선점(claimed)이 살아 있어 다시 잡지 못한다
    });
    await service.runOnce(NOW);
    service.onModuleDestroy();
    const before = writes.length;
    await service.runOnce(new Date(NOW.getTime() + 60_000));
    expect(sentWrites().filter((w) => writes.indexOf(w) >= before)).toHaveLength(0);
  });
});

describe('한도에 닿은 만료된 선점 정리', () => {
  it('시도 횟수가 한도 이상이고 선점이 만료된 claimed 만 gave_up 으로 닫는다', async () => {
    const { service, cleanups } = setup();
    await service.runOnce(NOW);
    const [cleanup] = cleanups;
    expect(cleanup!.filter).toMatchObject({
      day: DAY,
      state: 'claimed',
      claimedAt: { $lte: new Date(NOW.getTime() - REVIEW_REMIND_LEASE_MS) },
      attempts: { $gte: REVIEW_REMIND_MAX_ATTEMPTS },
    });
    expect(cleanup!.update).toEqual({ $set: { state: 'gave_up' } });
  });
});

describe('선점을 잃은 사용자는 목록에 남겨 이어받기를 시도한다', () => {
  it('선점을 잃으면 다른 서버의 선점이 만료될 때까지 선점 시도도 하지 않고, 만료 정각에 이어받아 정확히 1번 보낸다', async () => {
    const { service, push, reminders } = setup({
      rechecks: [null], // 첫 선점은 보내기 직전에 다른 서버(B)가 가져갔다. 다음 선점부터는 내 선점이 그대로
      stateDocs: [{ state: 'claimed', claimedAt: NOW, attempts: 2 }], // B 가 선점했고 보내기 전에 죽는다
    });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(1);
    await service.runOnce(new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS - 1000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(1); // B 의 선점이 살아 있는 동안은 건너뛴다
    await service.runOnce(new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('선점을 못 잡은 사용자도 다른 서버의 선점이 살아 있는 동안은 매 확인마다 건드리지 않는다', async () => {
    const { service, push, reminders } = setup({
      claimResults: [false, true],
      stateDocs: [{ state: 'claimed', claimedAt: NOW, attempts: 1 }],
    });
    await service.runOnce(NOW);
    for (const sec of [60, 120 - 1]) await service.runOnce(new Date(NOW.getTime() + sec * 1000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(1);
    await service.runOnce(new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('다른 서버가 보냈다면(문서가 끝난 상태) 목록에서 지우고 더 건드리지 않는다', async () => {
    const { service, push, reminders } = setup({
      rechecks: [null],
      stateDocs: [{ state: 'sent' }],
    });
    await service.runOnce(NOW);
    expect(service['plan']!.pending).toHaveLength(0);
    await service.runOnce(new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS + 1000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(push.send).not.toHaveBeenCalled();
  });

  it('연속으로 두 서버가 죽으면 보내지 않고 gave_up 으로 끝난다(시도 한도 3의 의도된 한계): 헛돌지 않고 목록에서도 지운다', async () => {
    const T2 = new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS); // 두 번째 서버(C)의 선점 시각
    const { service, push, reminders, cleanups } = setup({
      rechecks: [null], // 내(A) 첫 선점(#1)을 B(#2)가 가져가 죽는다
      claimResults: [true, 'dup'], // 이어받으려는 사이 C(#3)가 먼저 가져가 죽는다
      stateDocs: [
        { state: 'claimed', claimedAt: NOW, attempts: 2 },
        { state: 'claimed', claimedAt: T2, attempts: REVIEW_REMIND_MAX_ATTEMPTS },
      ],
      closeOnCleanup: { call: 3, users: [String(id(1))] }, // 한도에 닿은 만료된 선점을 정리가 gave_up 으로 닫는다
    });
    await service.runOnce(NOW);
    await service.runOnce(T2); // B 의 선점이 만료되어 이어받으려 했지만 C 가 먼저 가져갔다
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(2);
    await service.runOnce(new Date(T2.getTime() + REVIEW_REMIND_LEASE_MS)); // C 의 선점도 만료: 한도(3)라 더 이어받지 못한다
    expect(cleanups.at(-1)!.filter).toMatchObject({
      state: 'claimed',
      attempts: { $gte: REVIEW_REMIND_MAX_ATTEMPTS },
    });
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(2); // 더 선점하려 하지 않는다
    expect(service['plan']!.pending).toHaveLength(0); // 끝난 상태(gave_up)가 되어 목록에서 지워졌다
    await service.runOnce(new Date(T2.getTime() + 2 * REVIEW_REMIND_LEASE_MS));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(push.send).not.toHaveBeenCalled(); // 알림은 가지 않는다
  });

  it('기다릴 시각이 날짜를 넘어가면(자정 이후) 그 사용자는 목록에서 지운다', async () => {
    const late = seoul('23:59');
    const { service, push, reminders } = setup({
      claimResults: [false],
      stateDocs: [{ state: 'claimed', claimedAt: seoul('23:59') }], // 만료 시각은 다음 날 00:01
    });
    await service.runOnce(late);
    expect(service['plan']!.pending).toHaveLength(0);
    expect(service['waitUntil'].size).toBe(0);
    await service.runOnce(new Date(late.getTime() + 30_000));
    expect(reminders.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(push.send).not.toHaveBeenCalled();
  });

  it('발송 실패 뒤 다시 시도 시각이 날짜를 넘어가는 사용자도 목록에서 지운다', async () => {
    const { service } = setup({ send: failAll });
    await service.runOnce(seoul('23:59')); // 다시 시도는 2분 뒤 = 다음 날 00:01
    expect(service['plan']!.pending).toHaveLength(0);
    expect(service['waitUntil'].size).toBe(0);
  });

  it('날짜가 바뀌면 메모리 목록과 대기 항목을 모두 비운다', async () => {
    const { service } = setup({
      claimResults: [false],
      stateDocs: [{ state: 'claimed', claimedAt: NOW }],
    });
    await service.runOnce(NOW);
    expect(service['plan']!.pending).toHaveLength(1);
    expect(service['waitUntil'].size).toBe(1);
    await service.runOnce(seoul('00:30', NEXT_DAY)); // 서울 자정이 지났다
    expect(service['plan']).toBeNull();
    expect(service['waitUntil'].size).toBe(0);
  });
});

describe('발송 직전 마지막 조회 뒤에 날짜를 다시 확인한다', () => {
  it('선점 조회를 기다리는 사이 자정을 넘기면 보내지 않는다', async () => {
    const { service, push, clock, states } = setup({ lateAfterRecheck: true });
    await service.runOnce(undefined, clock(seoul('23:59'), seoul('00:00', NEXT_DAY)));
    expect(push.send).not.toHaveBeenCalled();
    expect(states()).toEqual(['claimed']); // 기록하지 않는다(전날 것이 다음 날로 넘어가지 않는다)
    expect(service['plan']!.pending).toHaveLength(0);
  });

  it('발송 직전 선점 조회는 state 가 claimed 인 내 선점만 본다(gave_up 으로 닫힌 선점은 보내지 않는다)', async () => {
    const { service, recheckFilters } = setup();
    await service.runOnce(NOW);
    expect(recheckFilters[0]).toMatchObject({
      userId: id(1),
      day: DAY,
      claimId: expect.any(String),
      state: 'claimed',
    });
  });
});
