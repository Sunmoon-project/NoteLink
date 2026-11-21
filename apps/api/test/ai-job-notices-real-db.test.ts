// 진짜 MongoDB에서 노트 변환 완료 푸시(FR-65-02)를 확인하는 테스트.
// 확인하는 것: 서버 둘이 동시에 runOnce 해도 푸시 1번, 다시 시도(retry) 뒤 다시 끝나면 재알림, 끝난 지 오래된 옛 작업 제외,
// 지운 노트 · 다른 작업으로 다시 연결된 노트는 푸시 없이 종료, 선점한 서버가 죽으면 2분 뒤 이어받기,
// 실패 재시도 3회 제한, notice 쓰기가 updatedAt(끝난 시각)을 바꾸지 않음, 인덱스.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다. ExpoPushService는 가짜다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/ai-job-notices-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import {
  AiJobNoticesService,
  NOTICE_LEASE_MS,
  NOTICE_MAX_ATTEMPTS,
  NOTICE_WINDOW_MS,
} from '../src/ai-jobs/ai-job-notices.service.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_notice_${process.pid}_${Date.now()}`;

const NOW = new Date('2026-11-17T12:00:00Z');
const minutesAgo = (m: number, from = NOW) => new Date(from.getTime() - m * 60_000);
const token = (n: string) => `ExponentPushToken[${n}]`;

type SendResult = {
  invalidTokens: string[];
  failedTickets: { message: { to: string }; error: string }[];
};

describe.skipIf(!isLocal)('진짜 DB 노트 변환 완료 푸시', () => {
  let conn: Connection;
  let jobs: Model<AiJob>;
  let materials: Model<Material>;
  let devices: Model<Device>;
  let sent: { to: string; title: string; body: string; data: Record<string, unknown> }[];
  let sendImpl: () => Promise<SendResult>;
  const user = new Types.ObjectId();
  const ok: SendResult = { invalidTokens: [], failedTickets: [] };

  const makeService = () =>
    new AiJobNoticesService(
      jobs as never,
      materials as never,
      devices as never,
      {
        send: (
          messages: { to: string; title: string; body: string; data: Record<string, unknown> }[],
        ) => {
          sent.push(...messages);
          return sendImpl();
        },
      } as never,
      // 알림함 · AI 알림 설정은 ai-job-quiz-notices-real-db.test.ts에서 본다. 여기서는 모두 받는다
      null as never,
      {
        saveToInbox: () => Promise.resolve(new Map([[String(user), 'n1']])),
        pushAllowed: (ids: unknown[]) => Promise.resolve(ids),
      } as never,
    );

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    devices = conn.model(Device.name, DeviceSchema) as unknown as Model<Device>;
    await Promise.all([jobs.syncIndexes(), devices.syncIndexes()]);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    sent = [];
    sendImpl = () => Promise.resolve(ok);
    await Promise.all([jobs.deleteMany({}), materials.deleteMany({}), devices.deleteMany({})]);
    await devices.create({
      userId: user,
      platform: 'android',
      pushToken: token('a'),
      locale: 'ko-KR',
      lastSeenAt: new Date(),
    });
  });

  /** 노트(바로 넣는다: 필수 필드를 다 채우지 않는다)와 그 노트를 가리키는 끝난 작업을 만든다 */
  const noteWithJob = async (
    over: Record<string, unknown> = {},
    note: {
      deletedAt?: Date | null;
      jobId?: 'self' | Types.ObjectId | null;
      regenJobId?: 'self' | Types.ObjectId | null;
    } = {},
  ) => {
    const materialId = new Types.ObjectId();
    const job = await jobs.create({
      type: 'handwriting_summary',
      status: 'succeeded',
      userId: user,
      targetType: 'material',
      targetId: materialId,
      input: {},
      ...over,
    } as never);
    // 처리기가 끝낸 시각(updatedAt)을 만든다. timestamps:false 로 써야 그 값이 그대로 남는다
    await jobs.updateOne(
      { _id: job._id },
      { $set: { updatedAt: minutesAgo(1) } },
      { timestamps: false },
    );
    await materials.collection.insertOne({
      _id: materialId,
      deletedAt: note.deletedAt ?? null,
      title: '영어 필기',
      processing: {
        jobId: note.jobId === undefined || note.jobId === 'self' ? job._id : note.jobId,
        regenJobId: note.regenJobId === 'self' ? job._id : (note.regenJobId ?? null),
      },
    });
    return { id: job._id, materialId };
  };
  const row = (id: Types.ObjectId) => jobs.findById(id).lean<AiJob & { updatedAt: Date }>();

  it('서버 둘이 같은 순간 runOnce 해도 푸시는 1번이고 sent 가 남는다', async () => {
    const { id, materialId } = await noteWithJob();
    await Promise.all([makeService().runOnce(NOW), makeService().runOnce(NOW)]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: token('a'),
      title: '노트 정리가 끝났어요',
      body: '영어 필기', // 본문은 노트 제목
      data: { type: 'note-summary', materialId: materialId.toHexString() },
    });
    expect((await row(id))!.notice?.state).toBe('sent');
    await makeService().runOnce(minutesAgo(-1)); // 이어서 확인해도 더 보내지 않는다
    expect(sent).toHaveLength(1);
  });

  it('notice 쓰기(선점 · sent)가 updatedAt(끝난 시각)을 바꾸지 않는다', async () => {
    const { id } = await noteWithJob();
    const before = (await row(id))!.updatedAt;
    await makeService().runOnce(NOW);
    const after = (await row(id))!;
    expect(after.notice?.state).toBe('sent');
    expect(after.updatedAt).toEqual(before);
  });

  it('다시 시도(retry)로 재설정되면 알림 상태가 지워지고, 다시 끝났을 때 다시 알린다', async () => {
    const { id } = await noteWithJob({ status: 'failed', error: 'x' });
    await makeService().runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toContain('실패');

    await new AiJobsService(jobs as never).retry(user.toHexString(), id.toHexString());
    const retried = (await row(id))!;
    expect(retried.status).toBe('queued');
    expect(retried.notice).toBeUndefined();
    await makeService().runOnce(NOW); // 아직 끝나지 않았으니 보내지 않는다
    expect(sent).toHaveLength(1);

    // 처리기가 두 번째 시도를 성공으로 끝냈다
    const finished = new Date(NOW.getTime() + 60_000);
    await jobs.updateOne(
      { _id: id },
      { $set: { status: 'succeeded', updatedAt: finished } },
      { timestamps: false },
    );
    await makeService().runOnce(new Date(finished.getTime() + 60_000));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.title).toBe('노트 정리가 끝났어요');
  });

  it('끝난 지 30분이 넘은 옛 작업과 취소 · 퀴즈 종류 · 진행 중 작업에는 보내지 않는다', async () => {
    const old = await noteWithJob();
    await jobs.updateOne(
      { _id: old.id },
      { $set: { updatedAt: new Date(NOW.getTime() - NOTICE_WINDOW_MS - 1000) } },
      { timestamps: false },
    );
    await noteWithJob({ status: 'canceled' });
    await noteWithJob({ type: 'quiz_generate' });
    await noteWithJob({ status: 'running' });
    await makeService().runOnce(NOW);
    expect(sent).toHaveLength(0);
    expect((await row(old.id))!.notice).toBeUndefined();
  });

  it('지운 노트 · 다른 작업으로 다시 연결된 노트는 푸시 없이 skipped 로 끝나고 다시 고르지 않는다', async () => {
    const deleted = await noteWithJob({}, { deletedAt: new Date() });
    const relinked = await noteWithJob({}, { jobId: new Types.ObjectId() });
    const before = (await row(deleted.id))!.updatedAt;
    await makeService().runOnce(NOW);
    await makeService().runOnce(NOW);
    expect(sent).toHaveLength(0);
    for (const j of [deleted, relinked]) {
      const r = (await row(j.id))!;
      expect(r.notice?.state).toBe('skipped');
      expect(r.notice?.attempts).toBe(1); // 두 번째 확인에서 다시 고르지 않았다
    }
    expect((await row(deleted.id))!.updatedAt).toEqual(before);
  });

  it('다시 만들기 작업(regenJobId)이 노트 동기화 전에 끝나면 알리고, 다른 다시 만들기가 걸린 옛 작업은 skipped(#634)', async () => {
    // 노트에 쓸 수 있는 결과(녹음 정리 슬라이드)여야 「끝났어요」다. 쓸 수 없으면 실패로 알린다(syncRegen 과 같은 판정)
    const regen = await noteWithJob(
      {
        type: 'recording_summary',
        result: { slides: [{ title: '도입', summary: '시작', startMs: 0, endMs: 1 }] },
      },
      { jobId: new Types.ObjectId(), regenJobId: 'self' },
    );
    await materials.collection.updateOne(
      { _id: regen.materialId },
      { $set: { kind: 'recording', 'processing.status': 'done' } },
    );
    const stale = await noteWithJob(
      {},
      { jobId: new Types.ObjectId(), regenJobId: new Types.ObjectId() },
    );
    await makeService().runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual(['노트 정리가 끝났어요']);
    expect((await row(regen.id))!.notice?.state).toBe('sent');
    expect((await row(stale.id))!.notice?.state).toBe('skipped');
  });

  it('선점한 서버가 죽어 claimed 로 남으면 2분 뒤 다른 서버가 이어받는다', async () => {
    const { id } = await noteWithJob();
    await jobs.updateOne(
      { _id: id },
      {
        $set: {
          'notice.state': 'claimed',
          'notice.claimId': 'dead',
          'notice.claimedAt': NOW,
          'notice.attempts': 1,
        },
      },
      { timestamps: false },
    );
    await makeService().runOnce(new Date(NOW.getTime() + NOTICE_LEASE_MS - 1000));
    expect(sent).toHaveLength(0);
    await makeService().runOnce(new Date(NOW.getTime() + NOTICE_LEASE_MS + 1000));
    expect(sent).toHaveLength(1);
    expect((await row(id))!.notice).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it(`발송이 계속 실패하면 ${NOTICE_MAX_ATTEMPTS}번까지만 다시 시도하고 gave_up 으로 멈춘다(updatedAt 은 그대로)`, async () => {
    const { id } = await noteWithJob();
    const before = (await row(id))!.updatedAt;
    sendImpl = () =>
      Promise.resolve({
        invalidTokens: [],
        failedTickets: [{ message: { to: token('a') }, error: 'x' }],
      });
    const svc = makeService();
    await svc.runOnce(NOW);
    expect((await row(id))!.notice?.state).toBeNull(); // 풀렸고 retryAt 이 잡혔다
    await svc.runOnce(new Date(NOW.getTime() + 60_000)); // 2분 전이라 건너뜀
    expect(sent).toHaveLength(1);
    await svc.runOnce(new Date(NOW.getTime() + 3 * 60_000));
    await svc.runOnce(new Date(NOW.getTime() + 20 * 60_000));
    await svc.runOnce(new Date(NOW.getTime() + 25 * 60_000));
    expect(sent).toHaveLength(NOTICE_MAX_ATTEMPTS);
    const done = (await row(id))!;
    expect(done.notice).toMatchObject({ state: 'gave_up', attempts: NOTICE_MAX_ATTEMPTS });
    expect(done.updatedAt).toEqual(before);
  });

  /** notice.state 를 쓰는 updateOne 을 앞에서부터 times 번 실패시킨다(나머지는 진짜 DB에 쓴다) */
  const failWrites = (state: string, times: number) => {
    const original = jobs.updateOne.bind(jobs);
    let n = 0;
    return vi.spyOn(jobs, 'updateOne').mockImplementation(((
      filter: never,
      update: { $set?: Record<string, unknown> },
      options: never,
    ) => {
      if (n < times && update.$set?.['notice.state'] === state) {
        n += 1;
        return Promise.reject(new Error('db down'));
      }
      return original(filter, update, options);
    }) as never);
  };
  const noWait = (svc: AiJobNoticesService) => {
    svc.recordWait = () => Promise.resolve();
    return svc;
  };

  it('발송 성공 뒤 sent 기록이 한 번 실패해도 푸시는 1번이고, 선점을 풀지 않고 sent 로 끝난다', async () => {
    const { id } = await noteWithJob();
    const spy = failWrites('sent', 1);
    try {
      const svc = noWait(makeService());
      await svc.runOnce(NOW);
      expect(sent).toHaveLength(1);
      expect((await row(id))!.notice).toMatchObject({ state: 'sent', attempts: 1 });
      await svc.runOnce(new Date(NOW.getTime() + 3 * 60_000));
      expect(sent).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('sent 기록이 끝내 실패해도 다음 확인에서 먼저 다시 써서 sent 가 되고 푸시는 1번이다(updatedAt 은 그대로)', async () => {
    const { id } = await noteWithJob();
    const before = (await row(id))!.updatedAt;
    const spy = failWrites('sent', 3); // 첫 확인의 기록 3번이 모두 실패
    try {
      const svc = noWait(makeService());
      await svc.runOnce(NOW);
      expect(sent).toHaveLength(1);
      expect((await row(id))!.notice?.state).toBe('claimed'); // 선점이 남아 있다
      await svc.runOnce(new Date(NOW.getTime() + 60_000)); // 선점이 아직 살아 있는 동안
      expect(sent).toHaveLength(1);
      const done = (await row(id))!;
      expect(done.notice).toMatchObject({ state: 'sent', attempts: 1 });
      expect(done.updatedAt).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('기록이 2분 넘게 안 되면 보관분은 버려지고 다른 서버가 이어받는다(문서화한 한계: 푸시가 한 번 더 간다)', async () => {
    const { id } = await noteWithJob();
    const spy = failWrites('sent', 3);
    try {
      const svc = noWait(makeService());
      await svc.runOnce(NOW);
      const first = (await row(id))!.notice?.claimId;
      await svc.runOnce(new Date(NOW.getTime() + NOTICE_LEASE_MS + 1000));
      const done = (await row(id))!;
      expect(done.notice?.claimId).not.toBe(first); // 옛 선점의 기록은 다시 쓰지 않았다
      expect(done.notice).toMatchObject({ state: 'sent', attempts: 2 });
      expect(sent).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('후보를 읽은 뒤 다른 서버가 먼저 재시도해 횟수가 올랐어도, 실제 3번째 실패면 gave_up 으로 기록한다(updatedAt 은 그대로)', async () => {
    const { id, materialId } = await noteWithJob({ status: 'failed' });
    const before = (await row(id))!.updatedAt;
    // 실제 DB: 이미 2번 시도하고 풀린 상태
    await jobs.updateOne(
      { _id: id },
      { $set: { 'notice.state': null, 'notice.attempts': 2, 'notice.retryAt': null } },
      { timestamps: false },
    );
    // 서버가 후보를 읽은 시점의 오래된 값: 시도 0번
    const stale = [
      {
        _id: id,
        type: 'handwriting_summary',
        status: 'failed',
        userId: user,
        targetId: materialId,
        notice: { attempts: 0 },
      },
    ];
    const chain = { sort: () => chain, limit: () => chain, lean: () => Promise.resolve(stale) };
    const spy = vi.spyOn(jobs, 'find').mockImplementation((() => chain) as never);
    sendImpl = () =>
      Promise.resolve({
        invalidTokens: [],
        failedTickets: [{ message: { to: token('a') }, error: 'x' }],
      });
    try {
      await makeService().runOnce(NOW);
    } finally {
      spy.mockRestore();
    }
    expect(sent).toHaveLength(1);
    const done = (await row(id))!;
    expect(done.notice).toMatchObject({ state: 'gave_up', attempts: NOTICE_MAX_ATTEMPTS });
    expect(done.updatedAt).toEqual(before);
  });

  it('시도 횟수가 한도에 닿은 만료된 claimed 는 gave_up 으로 닫고, 살아 있는 선점은 건드리지 않는다', async () => {
    const expired = await noteWithJob();
    const live = await noteWithJob();
    const before = (await row(expired.id))!.updatedAt;
    const claimed = (claimedAt: Date) => ({
      $set: {
        'notice.state': 'claimed',
        'notice.claimId': 'x',
        'notice.claimedAt': claimedAt,
        'notice.attempts': NOTICE_MAX_ATTEMPTS,
      },
    });
    await jobs.updateOne({ _id: expired.id }, claimed(minutesAgo(3)), { timestamps: false });
    await jobs.updateOne({ _id: live.id }, claimed(new Date(NOW.getTime() - 30_000)), {
      timestamps: false,
    });
    await makeService().runOnce(NOW);
    expect(sent).toHaveLength(0);
    const closed = (await row(expired.id))!;
    expect(closed.notice?.state).toBe('gave_up');
    expect(closed.updatedAt).toEqual(before);
    expect((await row(live.id))!.notice?.state).toBe('claimed');
  });

  it('기기를 읽는 동안 정리가 같은 claimId 의 선점을 gave_up 으로 닫았으면 보내지 않는다', async () => {
    const { id } = await noteWithJob();
    const before = (await row(id))!.updatedAt;
    // 기기를 읽는 동안(발송 직전 조회 전에) closeExhausted 가 이 선점을 gave_up 으로 닫는다: claimId 는 그대로 남는다
    const original = devices.find.bind(devices) as unknown as (...a: unknown[]) => {
      lean: (...x: unknown[]) => Promise<unknown>;
    };
    let closed = false;
    const spy = vi.spyOn(devices, 'find').mockImplementation(((...args: unknown[]) => {
      const query = original(...args);
      return {
        lean: async (...x: unknown[]) => {
          const rows = await query.lean(...x);
          if (!closed) {
            closed = true;
            await jobs.collection.updateOne({ _id: id }, { $set: { 'notice.state': 'gave_up' } });
          }
          return rows;
        },
      };
    }) as never);
    try {
      await makeService().runOnce(NOW);
    } finally {
      spy.mockRestore();
    }
    expect(sent).toHaveLength(0);
    const done = (await row(id))!;
    expect(done.notice?.state).toBe('gave_up'); // 보내지 않았고 다시 쓰지도 않았다
    expect(done.updatedAt).toEqual(before);
  });

  it('후보 조회용 인덱스(type · status · updatedAt)가 있다', async () => {
    const indexes = await jobs.collection.indexes();
    expect(
      indexes.some((i) => JSON.stringify(i.key) === '{"type":1,"status":1,"updatedAt":-1}'),
    ).toBe(true);
  });
});
