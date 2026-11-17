// 노트 변환 완료 푸시(FR-65-02) 단위 테스트: 가짜 모델로 대상 고르기 · 문구 · 노트 확인 · 선점 뒤 상태 변화 · 재시도 규칙 ·
// 기록 실패 처리(발송 성공 뒤 sent 기록이 실패해도 다시 보내지 않음) · 선점 응답의 실제 시도 횟수 · 한도에 닿은 선점 정리를 본다.
// 실제 DB에서 서버 둘이 겹칠 때 · 다시 시도 뒤 재알림 · 옛 작업 제외 · updatedAt 유지는 ai-job-notices-real-db.test.ts
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  NOTICE_LEASE_MS,
  NOTICE_MAX_ATTEMPTS,
  NOTICE_WINDOW_MS,
  AiJobNoticesService,
} from '../src/ai-jobs/ai-job-notices.service.js';

const NOW = new Date('2026-11-17T12:00:00Z');
const userId = new Types.ObjectId();

type Write = {
  filter: Record<string, unknown>;
  update: { $set?: Record<string, unknown> };
  options?: { timestamps?: boolean };
};

function setup(
  opts: {
    status?: string;
    /** 후보를 읽을 때의 시도 횟수(오래된 값일 수 있다) */
    attemptsBefore?: number;
    /** 선점 응답의 실제 시도 횟수(기본: attemptsBefore + 1) */
    claimedAttempts?: number;
    /** 선점 호출마다 성공(true)/이미 잡힘(false). 모자라면 true */
    claimResults?: boolean[];
    /** 후보 작업 수(기본 1) */
    jobCount?: number;
    /** 노트 제목 없이(기본 노트 문서) */
    noTitle?: boolean;
    /** 노트 문서(null이면 없음) */
    material?: {
      deletedAt?: Date | null;
      title?: string | null;
      processing?: { jobId?: Types.ObjectId | null };
    } | null;
    /** 선점 뒤 다시 읽은 작업(null이면 notice가 지워졌거나 선점이 풀림) */
    recheck?: { status: string } | null;
    devices?: string[];
    send?: () => unknown;
    deleteFails?: boolean;
    /** 이 상태를 쓰는 updateOne을 앞에서부터 times번 실패시킨다 */
    failWrite?: { state: string | null; times: number };
    /** 기기를 읽는 동안 정리가 같은 claimId 의 선점을 gave_up 으로 닫는다(DB 문서의 notice.state 가 claimed 가 아니게 된다) */
    gaveUpDuringDevices?: boolean;
  } = {},
) {
  const makeJob = () => ({
    _id: new Types.ObjectId(),
    type: 'handwriting_summary',
    status: opts.status ?? 'succeeded',
    userId,
    targetType: 'material',
    targetId: new Types.ObjectId(),
    updatedAt: new Date(NOW.getTime() - 60_000),
    notice: opts.attemptsBefore ? { attempts: opts.attemptsBefore } : undefined,
  });
  const jobList = Array.from({ length: opts.jobCount ?? 1 }, makeJob);
  const job = jobList[0]!;
  const filters: Record<string, unknown>[] = [];
  const writes: Write[] = []; // 선점(findOneAndUpdate) · 기록(updateOne)을 부른 차례대로
  const cleanups: Write[] = [];
  let claimCalls = 0;
  let gaveUp = false;
  const recheckFilters: Record<string, unknown>[] = [];
  let failed = 0;
  const jobs = {
    find: (filter: Record<string, unknown>) => {
      filters.push(filter);
      const chain = { sort: () => chain, limit: () => chain, lean: () => Promise.resolve(jobList) };
      return chain;
    },
    findOneAndUpdate: vi.fn(
      (filter: Write['filter'], update: Write['update'], options: Write['options']) => {
        writes.push({ filter, update, options });
        const ok = opts.claimResults?.[claimCalls++] ?? true;
        return {
          lean: () =>
            Promise.resolve(
              ok
                ? {
                    _id: filter['_id'],
                    notice: { attempts: opts.claimedAttempts ?? (opts.attemptsBefore ?? 0) + 1 },
                  }
                : null,
            ),
        };
      },
    ),
    updateOne: vi.fn(
      (filter: Write['filter'], update: Write['update'], options: Write['options']) => {
        writes.push({ filter, update, options });
        const target = opts.failWrite;
        if (target && failed < target.times && update.$set?.['notice.state'] === target.state) {
          failed += 1;
          return Promise.reject(new Error('db down'));
        }
        return Promise.resolve({ matchedCount: 1 });
      },
    ),
    updateMany: vi.fn(
      (filter: Write['filter'], update: Write['update'], options: Write['options']) => {
        cleanups.push({ filter, update, options });
        return Promise.resolve({ modifiedCount: 0 });
      },
    ),
    findOne: vi.fn((filter: Record<string, unknown>) => {
      recheckFilters.push(filter);
      return {
        lean: () => {
          // DB 처럼 조건을 본다: notice.state 가 claimed 여야 한다고 물었는데 이미 gave_up 이면 문서가 없다
          if (gaveUp && filter['notice.state'] === 'claimed') return Promise.resolve(null);
          return Promise.resolve(
            opts.recheck === undefined ? { status: job.status } : opts.recheck,
          );
        },
      };
    }),
  };
  const materials = {
    findOne: (filter: { _id: Types.ObjectId }) => ({
      lean: () => {
        if (opts.material !== undefined) return Promise.resolve(opts.material);
        const owner = jobList.find((j) => String(j.targetId) === String(filter._id)) ?? job;
        return Promise.resolve({
          deletedAt: null,
          ...(opts.noTitle ? {} : { title: '영어 필기' }),
          processing: { jobId: owner._id },
        });
      },
    }),
  };
  const devices = {
    find: () => ({
      lean: () => {
        if (opts.gaveUpDuringDevices) gaveUp = true;
        return Promise.resolve(
          (opts.devices ?? ['ExponentPushToken[aaa]']).map((pushToken) => ({ pushToken })),
        );
      },
    }),
    deleteMany: vi.fn(() =>
      opts.deleteFails ? Promise.reject(new Error('db down')) : Promise.resolve(),
    ),
  };
  const push = {
    send: vi.fn(() => opts.send?.() ?? Promise.resolve({ invalidTokens: [], failedTickets: [] })),
  };
  const service = new AiJobNoticesService(
    jobs as never,
    materials as never,
    devices as never,
    push as never,
  );
  // 기록 재시도 사이의 기다림은 테스트에서 실제로 기다리지 않는다
  const waits: number[] = [];
  service.recordWait = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const noticeState = () =>
    writes.map((u) => u.update.$set?.['notice.state']).filter((s) => s !== undefined);
  const sentWrites = () => writes.filter((w) => w.update.$set?.['notice.state'] === 'sent');
  return {
    service,
    job,
    jobList,
    push,
    filters,
    writes,
    cleanups,
    waits,
    noticeState,
    sentWrites,
    recheckFilters,
  };
}

const failAll = () =>
  Promise.resolve({
    invalidTokens: [],
    failedTickets: [{ message: { to: 'ExponentPushToken[aaa]' }, error: 'x' }],
  });

describe('AiJobNoticesService 대상 고르기', () => {
  it('요약 3종 · 노트 대상 · 성공/실패 · 최근 30분 · 시도 한도 안만 찾는다(취소 · 퀴즈 종류는 조건에 없다)', async () => {
    const { service, filters } = setup();
    await service.runOnce(NOW);
    expect(filters[0]).toMatchObject({
      type: { $in: ['handwriting_summary', 'recording_summary', 'document_summary'] },
      targetType: 'material',
      status: { $in: ['succeeded', 'failed'] },
      updatedAt: { $gte: new Date(NOW.getTime() - NOTICE_WINDOW_MS) },
      $or: [{ 'notice.attempts': null }, { 'notice.attempts': { $lt: NOTICE_MAX_ATTEMPTS } }],
    });
  });

  it('성공하면 "노트 정리가 끝났어요", 본문은 노트 제목, materialId 를 보낸다', async () => {
    const { service, push, job, noticeState } = setup();
    await service.runOnce(NOW);
    const [messages] = push.send.mock.calls[0] as unknown as [
      {
        to: string;
        title: string;
        body: string;
        data: Record<string, unknown>;
        collapseId: string;
      }[],
    ];
    expect(messages[0]).toMatchObject({
      to: 'ExponentPushToken[aaa]',
      title: '노트 정리가 끝났어요',
      body: '영어 필기',
      data: { type: 'note-summary', materialId: job.targetId.toHexString(), status: 'succeeded' },
      collapseId: `ai-job-done:${job._id.toHexString()}`,
    });
    expect(noticeState()).toContain('sent');
  });

  it('노트 제목이 없으면 본문은 비운다', async () => {
    const { service, push } = setup({ noTitle: true });
    await service.runOnce(NOW);
    const [messages] = push.send.mock.calls[0] as unknown as [{ body: string }[]];
    expect(messages[0]!.body).toBe('');
  });

  it('실패하면 다시 시도 안내 문구를 보낸다', async () => {
    const { service, push } = setup({ status: 'failed' });
    await service.runOnce(NOW);
    const [messages] = push.send.mock.calls[0] as unknown as [{ title: string; data: unknown }[]];
    expect(messages[0]!.title).toBe('노트 정리에 실패했어요. 다시 시도해 주세요');
    expect(messages[0]!.data).toMatchObject({ status: 'failed' });
  });

  it('notice 를 쓰는 모든 쓰기(선점 · 기록 · 정리)에 timestamps:false 를 준다(updatedAt 이 끝난 시각으로 남는다)', async () => {
    const { service, writes, cleanups } = setup();
    await service.runOnce(NOW);
    expect(writes.length).toBeGreaterThanOrEqual(2); // 선점 + sent
    expect(cleanups.length).toBeGreaterThanOrEqual(1);
    for (const u of [...writes, ...cleanups])
      expect(u.options).toMatchObject({ timestamps: false });
  });
});

describe('보내기 전에 노트를 확인한다', () => {
  it('지운 노트면 푸시 없이 skipped 로 기록한다', async () => {
    const { service, push, noticeState } = setup({
      material: { deletedAt: new Date(), processing: { jobId: undefined } },
    });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed', 'skipped']);
  });

  it('노트가 다른 작업으로 다시 연결됐으면 푸시 없이 skipped 로 기록한다', async () => {
    const { service, push, noticeState } = setup({
      material: { deletedAt: null, processing: { jobId: new Types.ObjectId() } },
    });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed', 'skipped']);
  });

  it('노트 문서가 아예 없어도 skipped', async () => {
    const { service, push, noticeState } = setup({ material: null });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed', 'skipped']);
  });
});

describe('선점 뒤 · 발송 결과', () => {
  it('선점한 뒤 작업이 다시 시도되어 상태가 바뀌었으면(내 선점이 사라졌으면) 보내지 않고 아무것도 쓰지 않는다', async () => {
    const { service, push, noticeState } = setup({ recheck: null });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed']);
  });

  it('이미 다른 서버가 잡았으면(선점 실패) 보내지 않는다', async () => {
    const { service, push, noticeState } = setup({ claimResults: [false] });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed']); // 선점 시도만 있었다
  });

  it('만료 토큰 삭제가 실패해도 발송은 성공으로 기록한다(재발송하지 않는다)', async () => {
    const { service, noticeState } = setup({
      deleteFails: true,
      send: () => Promise.resolve({ invalidTokens: ['ExponentPushToken[bad]'], failedTickets: [] }),
      devices: ['ExponentPushToken[bad]', 'ExponentPushToken[aaa]'],
    });
    await service.runOnce(NOW);
    expect(noticeState()).toEqual(['claimed', 'sent']);
  });

  it('기기가 없으면 보내지 않고 sent 로 끝낸다', async () => {
    const { service, push, noticeState } = setup({ devices: [] });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed', 'sent']);
  });

  it('보낼 기기가 있는데 전부 실패하면 선점을 풀고 2분 뒤로 다시 시도를 예약한다', async () => {
    const { service, writes } = setup({ send: failAll });
    await service.runOnce(NOW);
    const release = writes.at(-1)!.update.$set!;
    expect(release['notice.state']).toBeNull();
    expect(release['notice.retryAt']).toEqual(new Date(NOW.getTime() + 2 * 60_000));
  });

  it(`${NOTICE_MAX_ATTEMPTS}번째 시도도 실패하면 gave_up 으로 포기한다`, async () => {
    const { service, noticeState } = setup({
      attemptsBefore: NOTICE_MAX_ATTEMPTS - 1,
      send: failAll,
    });
    await service.runOnce(NOW);
    expect(noticeState()).toEqual(['claimed', 'gave_up']);
  });

  it('발송 중 오류는 선점을 풀어 다시 시도를 예약한다(기록 오류와 다르다)', async () => {
    const { service, writes } = setup({ send: () => Promise.reject(new Error('network')) });
    await service.runOnce(NOW);
    expect(writes.at(-1)!.update.$set!['notice.state']).toBeNull();
  });
});

describe('오래된 조회 값이 아니라 선점 응답의 실제 시도 횟수로 판정한다', () => {
  it('후보를 읽을 땐 0번이었는데 그사이 다른 서버가 재시도해 실제로는 3번째면, 실패 시 gave_up 으로 기록한다', async () => {
    const { service, noticeState, writes } = setup({
      attemptsBefore: 0, // 오래된 조회 값
      claimedAttempts: NOTICE_MAX_ATTEMPTS, // 선점 응답의 실제 값
      send: failAll,
    });
    await service.runOnce(NOW);
    expect(noticeState()).toEqual(['claimed', 'gave_up']);
    // 선점은 증가된 문서를 돌려받는다(returnDocument: after) · timestamps:false 유지
    expect(writes[0]!.options).toMatchObject({ returnDocument: 'after', timestamps: false });
  });

  it('실제 값이 한도 전이면 오래된 값과 상관없이 그 횟수의 대기로 다시 시도를 예약한다', async () => {
    const { service, writes } = setup({ attemptsBefore: 0, claimedAttempts: 2, send: failAll });
    await service.runOnce(NOW);
    const release = writes.at(-1)!.update.$set!;
    expect(release['notice.state']).toBeNull();
    expect(release['notice.retryAt']).toEqual(new Date(NOW.getTime() + 10 * 60_000)); // 2번째 실패 뒤 10분
  });
});

describe('발송 성공 뒤 기록 실패는 다시 보내지 않는다', () => {
  it('sent 기록이 한 번 실패해도 푸시는 1번이고, 선점을 풀지 않고 sent 만 다시 쓴다', async () => {
    const { service, push, noticeState, waits } = setup({
      failWrite: { state: 'sent', times: 1 },
    });
    await service.runOnce(NOW);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(noticeState()).toEqual(['claimed', 'sent', 'sent']); // 실패 1번 + 성공
    expect(noticeState()).not.toContain(null); // 선점을 풀지 않았다
    expect(waits).toEqual([200]); // 다시 쓰기 전 0.2초(테스트에서는 기다리지 않는다)
  });

  it('기록 다시 쓰기 사이의 대기는 0.2초 · 0.5초이고, 모두 실패해도 푸시는 1번(선점은 그대로)', async () => {
    const { service, push, noticeState, waits } = setup({
      failWrite: { state: 'sent', times: 3 },
    });
    await service.runOnce(NOW);
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([200, 500]);
    expect(noticeState()).toEqual(['claimed', 'sent', 'sent', 'sent']);
    expect(noticeState()).not.toContain(null);
  });

  it('끝내 기록하지 못한 sent 는 다음 확인에서 먼저 다시 쓰고, 푸시는 늘어나지 않는다', async () => {
    const { service, push, writes, sentWrites } = setup({
      failWrite: { state: 'sent', times: 3 },
      claimResults: [true, false, false], // 다음 확인들은 선점이 아직 살아 있어 잡지 못한다
    });
    await service.runOnce(NOW);
    const claimId = writes[0]!.update.$set!['notice.claimId'];
    await service.runOnce(new Date(NOW.getTime() + 60_000));
    expect(push.send).toHaveBeenCalledTimes(1);
    // 다시 쓸 때도 내 선점(claimId) 조건과 timestamps:false 를 그대로 쓴다
    const last = sentWrites().at(-1)!;
    expect(last.filter).toMatchObject({ 'notice.claimId': claimId });
    expect(last.options).toEqual({ timestamps: false });
    // 첫 확인의 3번(모두 실패) + 다음 확인의 먼저 다시 쓰기 1번(성공)
    expect(sentWrites()).toHaveLength(4);
    // 한 번 다시 썼으면 더는 들고 있지 않는다
    await service.runOnce(new Date(NOW.getTime() + 90_000));
    expect(sentWrites()).toHaveLength(4);
  });

  it('선점 만료(2분)가 지난 기록분은 다시 쓰지 않고 버린다(그 뒤에는 다른 서버가 이어받았을 수 있다)', async () => {
    const { service, push, sentWrites } = setup({
      failWrite: { state: 'sent', times: 3 },
      claimResults: [true, false],
    });
    await service.runOnce(NOW);
    await service.runOnce(new Date(NOW.getTime() + NOTICE_LEASE_MS + 1000));
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(sentWrites()).toHaveLength(3); // 첫 확인의 3번뿐: 만료 뒤에는 다시 쓰지 않았다
  });

  it('보관 개수 상한을 넘으면 오래된 것부터 버린다', async () => {
    const { service, writes, jobList, sentWrites } = setup({
      jobCount: 3,
      failWrite: { state: 'sent', times: 9 },
      claimResults: [true, true, true, false, false, false],
    });
    service.unrecordedLimit = 2;
    await service.runOnce(NOW);
    const before = writes.length;
    await service.runOnce(new Date(NOW.getTime() + 30_000));
    const rewritten = sentWrites()
      .filter((w) => writes.indexOf(w) >= before)
      .map((w) => String(w.filter['_id']));
    // 세 작업의 기록이 모두 실패했지만 2개만 남아 있다: 첫 작업은 버려졌다
    expect(rewritten).not.toContain(String(jobList[0]!._id));
    expect(new Set(rewritten)).toEqual(new Set([String(jobList[1]!._id), String(jobList[2]!._id)]));
  });

  it('서버가 꺼질 때(onModuleDestroy) 보관한 기록분을 정리한다', async () => {
    const { service, writes, sentWrites } = setup({
      failWrite: { state: 'sent', times: 3 },
      claimResults: [true, false],
    });
    await service.runOnce(NOW);
    service.onModuleDestroy();
    const before = writes.length;
    await service.runOnce(new Date(NOW.getTime() + 60_000));
    expect(sentWrites().filter((w) => writes.indexOf(w) >= before)).toHaveLength(0);
  });
});

describe('한도에 닿은 만료된 선점 정리', () => {
  it('시도 횟수가 한도 이상이고 선점이 만료된 claimed 만 gave_up 으로 닫는다(살아 있는 선점은 건드리지 않는다)', async () => {
    const { service, cleanups } = setup();
    await service.runOnce(NOW);
    const [cleanup] = cleanups;
    expect(cleanup!.filter).toMatchObject({
      'notice.state': 'claimed',
      'notice.claimedAt': { $lte: new Date(NOW.getTime() - NOTICE_LEASE_MS) },
      'notice.attempts': { $gte: NOTICE_MAX_ATTEMPTS },
    });
    expect(cleanup!.update).toEqual({ $set: { 'notice.state': 'gave_up' } });
    expect(cleanup!.options).toEqual({ timestamps: false });
  });
});

describe('발송 직전 선점 조회는 claimed 인 내 선점만 본다', () => {
  it('기기를 읽는 동안 정리가 같은 claimId 의 선점을 gave_up 으로 닫았으면 보내지 않고 아무것도 쓰지 않는다', async () => {
    const { service, push, noticeState } = setup({ gaveUpDuringDevices: true });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed']);
  });

  it('조회 조건에 notice.state: claimed 가 들어간다', async () => {
    const { service, recheckFilters, job } = setup();
    await service.runOnce(NOW);
    expect(recheckFilters[0]).toMatchObject({
      _id: job._id,
      status: job.status,
      'notice.claimId': expect.any(String),
      'notice.state': 'claimed',
    });
  });
});
