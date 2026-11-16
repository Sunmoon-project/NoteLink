// 노트 변환 완료 푸시(FR-65-02) 단위 테스트: 가짜 모델로 대상 고르기 · 문구 · 노트 확인 · 선점 뒤 상태 변화 · 재시도 규칙을 본다.
// 실제 DB에서 서버 둘이 겹칠 때 · 다시 시도 뒤 재알림 · 옛 작업 제외 · updatedAt 유지는 ai-job-notices-real-db.test.ts
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  NOTICE_MAX_ATTEMPTS,
  NOTICE_WINDOW_MS,
  AiJobNoticesService,
} from '../src/ai-jobs/ai-job-notices.service.js';

const NOW = new Date('2026-11-17T12:00:00Z');
const userId = new Types.ObjectId();

type Update = {
  filter: Record<string, unknown>;
  update: { $set?: Record<string, unknown> };
  options?: { timestamps?: boolean };
};

function setup(
  opts: {
    status?: string;
    attemptsBefore?: number;
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
  } = {},
) {
  const job = {
    _id: new Types.ObjectId(),
    type: 'handwriting_summary',
    status: opts.status ?? 'succeeded',
    userId,
    targetType: 'material',
    targetId: new Types.ObjectId(),
    updatedAt: new Date(NOW.getTime() - 60_000),
    notice: opts.attemptsBefore ? { attempts: opts.attemptsBefore } : undefined,
  };
  const filters: Record<string, unknown>[] = [];
  const updates: Update[] = [];
  const jobs = {
    find: (filter: Record<string, unknown>) => {
      filters.push(filter);
      const chain = { sort: () => chain, limit: () => chain, lean: () => Promise.resolve([job]) };
      return chain;
    },
    updateOne: vi.fn(
      (filter: Update['filter'], update: Update['update'], options: Update['options']) => {
        updates.push({ filter, update, options });
        return Promise.resolve({ matchedCount: 1 });
      },
    ),
    findOne: () => ({
      lean: () =>
        Promise.resolve(opts.recheck === undefined ? { status: job.status } : opts.recheck),
    }),
  };
  const materials = {
    findOne: () => ({
      lean: () =>
        Promise.resolve(
          opts.material === undefined
            ? {
                deletedAt: null,
                ...(opts.noTitle ? {} : { title: '영어 필기' }),
                processing: { jobId: job._id },
              }
            : opts.material,
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
  const push = {
    send: vi.fn(() => opts.send?.() ?? Promise.resolve({ invalidTokens: [], failedTickets: [] })),
  };
  const service = new AiJobNoticesService(
    jobs as never,
    materials as never,
    devices as never,
    push as never,
  );
  const noticeState = () =>
    updates.map((u) => u.update.$set?.['notice.state']).filter((s) => s !== undefined);
  return { service, job, push, filters, updates, devices, noticeState };
}

describe('AiJobNoticesService 대상 고르기', () => {
  it('요약 3종 · 노트 대상 · 성공/실패 · 최근 30분 안만 찾는다(취소 · 퀴즈 종류는 조건에 없다)', async () => {
    const { service, filters } = setup();
    await service.runOnce(NOW);
    expect(filters[0]).toMatchObject({
      type: { $in: ['handwriting_summary', 'recording_summary', 'document_summary'] },
      targetType: 'material',
      status: { $in: ['succeeded', 'failed'] },
      updatedAt: { $gte: new Date(NOW.getTime() - NOTICE_WINDOW_MS) },
    });
  });

  it('성공하면 "노트 정리가 끝났어요"와 materialId 를 보낸다', async () => {
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
      body: '영어 필기', // 본문은 노트 제목
      data: { type: 'note-summary', materialId: job.targetId.toHexString(), status: 'succeeded' },
      collapseId: `ai-job-done:${job._id.toHexString()}`,
    });
    expect(noticeState()).toContain('sent');
  });

  it('노트 제목이 없으면 본문은 비운다', async () => {
    const { service, push } = setup({
      noTitle: true,
    });
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

  it('notice 를 쓰는 모든 쓰기에 timestamps:false 를 준다(updatedAt 이 끝난 시각으로 남는다)', async () => {
    const { service, updates } = setup();
    await service.runOnce(NOW);
    expect(updates.length).toBeGreaterThanOrEqual(2); // 선점 + sent
    for (const u of updates) expect(u.options).toEqual({ timestamps: false });
  });
});

describe('보내기 전에 노트를 확인한다', () => {
  it('지운 노트면 푸시 없이 skipped 로 기록한다', async () => {
    const { service, push, noticeState, updates } = setup({
      material: { deletedAt: new Date(), processing: { jobId: undefined } },
    });
    await service.runOnce(NOW);
    expect(push.send).not.toHaveBeenCalled();
    expect(noticeState()).toEqual(['claimed', 'skipped']);
    for (const u of updates) expect(u.options).toEqual({ timestamps: false });
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
    const { service, updates } = setup({
      send: () =>
        Promise.resolve({
          invalidTokens: [],
          failedTickets: [{ message: { to: 'ExponentPushToken[aaa]' }, error: 'x' }],
        }),
    });
    await service.runOnce(NOW);
    const release = updates.at(-1)!.update.$set!;
    expect(release['notice.state']).toBeNull();
    expect(release['notice.retryAt']).toEqual(new Date(NOW.getTime() + 2 * 60_000));
  });

  it(`${NOTICE_MAX_ATTEMPTS}번째 시도도 실패하면 gave_up 으로 포기한다`, async () => {
    const { service, noticeState } = setup({
      attemptsBefore: NOTICE_MAX_ATTEMPTS - 1,
      send: () =>
        Promise.resolve({
          invalidTokens: [],
          failedTickets: [{ message: { to: 'ExponentPushToken[aaa]' }, error: 'x' }],
        }),
    });
    await service.runOnce(NOW);
    expect(noticeState()).toEqual(['claimed', 'gave_up']);
  });
});
