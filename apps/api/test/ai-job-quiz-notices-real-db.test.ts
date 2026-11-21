// 진짜 MongoDB에서 퀴즈 생성 완료 · 실패 알림(#560 PR 4, FR-65-02)을 확인하는 테스트.
// 확인하는 것: 퀴즈 만들기 · 유사 문제 · 사용자가 기다린 미리 만들기가 끝나면 알림함 저장 + 푸시, 기다리지 않은 미리 만들기 ·
// 지운 세트는 제외, AI 알림을 끈 사람은 저장 · 푸시 모두 없음, 조용한 시간에는 알림함에만, 노트 정리 알림도 알림함에 남음.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 전용 DB를 만들고 끝나면 지운다. ExpoPushService는 가짜다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27167/?directConnection=true" npm run test -w @notelink/api -- test/ai-job-quiz-notices-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AiJobNoticesService } from '../src/ai-jobs/ai-job-notices.service.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import {
  Notification,
  NotificationSchema,
} from '../src/modules/notification/schemas/notification.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_quiz_notice_${process.pid}_${Date.now()}`;

// 서울 2026-11-19 21:00
const NOW = new Date('2026-11-19T12:00:00Z');
const token = (n: string) => `ExponentPushToken[${n}]`;
type Sent = { to: string; title: string; body: string; data: Record<string, unknown> };

describe.skipIf(!isLocal)('진짜 DB 퀴즈 생성 알림', () => {
  let conn: Connection;
  let jobs: Model<AiJob>;
  let materials: Model<Material>;
  let sets: Model<QuizSet>;
  let devices: Model<Device>;
  let users: Model<User>;
  let notifications: Model<Notification>;
  let sent: Sent[];
  let service: AiJobNoticesService;
  const me = new Types.ObjectId();

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    sets = conn.model(QuizSet.name, QuizSetSchema) as unknown as Model<QuizSet>;
    devices = conn.model(Device.name, DeviceSchema) as unknown as Model<Device>;
    users = conn.model(User.name, UserSchema) as unknown as Model<User>;
    notifications = conn.model(
      Notification.name,
      NotificationSchema,
    ) as unknown as Model<Notification>;
    await Promise.all([jobs.syncIndexes(), devices.syncIndexes(), notifications.syncIndexes()]);
    const push = {
      send: (messages: Sent[]) => {
        sent.push(...messages);
        return Promise.resolve({ invalidTokens: [], failedTickets: [] });
      },
    };
    const notifier = new NotificationService(
      notifications as never,
      users as never,
      devices as never,
      push as never,
    );
    service = new AiJobNoticesService(
      jobs as never,
      materials as never,
      devices as never,
      push as never,
      sets as never,
      notifier,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    sent = [];
    await Promise.all(
      [jobs, materials, sets, devices, users, notifications].map((m) =>
        (m as Model<unknown>).deleteMany({}),
      ),
    );
    await users.create({ _id: me, nickname: '나나', email: null });
    await devices.create({
      userId: me,
      platform: 'ios',
      pushToken: token('me'),
      locale: 'ko-KR',
      lastSeenAt: NOW,
    });
  });

  /** 끝난 작업 + 그 작업을 가리키는 퀴즈 세트(바로 넣는다: 필수 필드를 다 채우지 않는다) */
  const quizJob = async (
    over: Record<string, unknown> = {},
    set: { deletedAt?: Date | null; none?: boolean; status?: string; questionCount?: number } = {},
  ) => {
    const setId = new Types.ObjectId();
    const job = await jobs.create({
      type: 'quiz_generate',
      status: 'succeeded',
      userId: me,
      targetType: 'quiz_set',
      targetId: setId,
      input: {},
      ...over,
    } as never);
    await jobs.updateOne(
      { _id: job._id },
      { $set: { updatedAt: new Date(NOW.getTime() - 60_000) } },
      { timestamps: false },
    );
    if (!set.none)
      await sets.collection.insertOne({
        _id: setId,
        ownerId: me,
        title: '영어 단어',
        jobId: job._id,
        deletedAt: set.deletedAt ?? null,
        ...(set.status ? { status: set.status, questionCount: set.questionCount ?? 0 } : {}),
      });
    return { id: job._id, setId };
  };

  it('퀴즈 만들기가 끝나면 알림함에 남기고 푸시한다(눌렀을 때 세트로 가는 data)', async () => {
    const { setId } = await quizJob();
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: '퀴즈가 준비됐어요',
      body: '영어 단어',
      data: { type: 'quiz-ready', quizSetId: setId.toHexString(), status: 'succeeded' },
    });
    const rows = await notifications.find({ userId: me }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'quiz-ready', title: '퀴즈가 준비됐어요' });
    expect(sent[0]!.data.notificationId).toBe(String(rows[0]!._id));
  });

  it('실패 · 유사 문제는 문구가 다르다', async () => {
    await quizJob({ status: 'failed' });
    // 유사 문제는 세트의 상태 · 문제 수를 본다(#634): 문제가 있는 ready 세트
    await quizJob({ type: 'similar_quiz' }, { status: 'ready', questionCount: 3 });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title).sort()).toEqual([
      '유사 문제가 준비됐어요',
      '퀴즈를 만들지 못했어요. 다시 시도해 주세요',
    ]);
  });

  it('유사 문제를 하나도 못 만들어 세트가 failed 면 「준비됐어요」 대신 실패를 알린다(#634, COM-004)', async () => {
    const { id } = await quizJob(
      { type: 'similar_quiz', result: { reviewQuestions: [], srsUpdates: [] } },
      { status: 'failed' },
    );
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: '유사 문제를 만들지 못했어요. 다시 시도해 주세요',
      data: { type: 'quiz-ready', status: 'failed' },
    });
    expect(sent[0]!.data.quizSetId).toBeUndefined();
    expect((await jobs.findById(id).lean())!.notice?.state).toBe('sent');
  });

  it('사용자가 기다린 미리 만들기(awaited)만 알리고, 기다리지 않은 것 · 지운 세트 · 세트 없는 것은 알리지 않는다', async () => {
    const materialId = new Types.ObjectId();
    await quizJob({
      type: 'quiz_pregen',
      targetType: 'material',
      targetId: materialId,
      awaited: true,
    });
    await quizJob({ type: 'quiz_pregen', targetType: 'material', targetId: materialId });
    await quizJob({}, { deletedAt: NOW });
    await quizJob({}, { none: true });
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(await notifications.countDocuments()).toBe(1);
  });

  it('이어받은 미리 만들기의 세트가 아직 없으면 끝내지 않고 조금 뒤 다시 본다', async () => {
    const { id } = await quizJob(
      {
        type: 'quiz_pregen',
        targetType: 'material',
        targetId: new Types.ObjectId(),
        awaited: true,
      },
      { none: true },
    );
    await service.runOnce(NOW);
    expect(sent).toHaveLength(0);
    const notice = (await jobs.findById(id).lean())!.notice;
    expect(notice?.state).toBeNull();
    expect(notice?.retryAt).toBeInstanceOf(Date);
  });

  it('기다린 미리 만들기가 실패하면 세트가 없어도 다시 시도하지 않고 바로 실패를 알린다(퀴즈 탭으로)', async () => {
    const { id } = await quizJob(
      {
        type: 'quiz_pregen',
        status: 'failed',
        targetType: 'material',
        targetId: new Types.ObjectId(),
        awaited: true,
      },
      { none: true },
    );
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: '퀴즈를 만들지 못했어요. 다시 시도해 주세요',
      data: { type: 'quiz-ready', status: 'failed' },
    });
    expect(sent[0]!.data.quizSetId).toBeUndefined();
    expect((await jobs.findById(id).lean())!.notice?.state).toBe('sent');
  });

  it('AI 알림을 끈 사람에게는 저장 · 푸시 모두 없다(작업은 skipped로 끝난다)', async () => {
    await users.updateOne({ _id: me }, { $set: { 'settings.notifyAi': false } });
    const { id } = await quizJob();
    await service.runOnce(NOW);
    expect(sent).toHaveLength(0);
    expect(await notifications.countDocuments()).toBe(0);
    expect((await jobs.findById(id).lean())!.notice?.state).toBe('skipped');
  });

  it('조용한 시간에는 알림함에만 남긴다', async () => {
    await users.updateOne(
      { _id: me },
      { $set: { 'settings.quietHours': { start: '20:00', end: '22:00' } } },
    );
    const { id } = await quizJob();
    await service.runOnce(NOW);
    expect(sent).toHaveLength(0);
    expect(await notifications.countDocuments()).toBe(1);
    expect((await jobs.findById(id).lean())!.notice?.state).toBe('sent');
  });

  it('푸시를 받을 기기가 없어도 알림함에는 남긴다', async () => {
    await devices.deleteMany({});
    const { id } = await quizJob();
    await service.runOnce(NOW);
    expect(sent).toHaveLength(0);
    expect(await notifications.countDocuments({ userId: me })).toBe(1);
    expect((await jobs.findById(id).lean())!.notice?.state).toBe('sent');
  });

  it('노트 정리 알림도 알림함에 남는다', async () => {
    const materialId = new Types.ObjectId();
    const job = await jobs.create({
      type: 'handwriting_summary',
      status: 'succeeded',
      userId: me,
      targetType: 'material',
      targetId: materialId,
      input: {},
    } as never);
    await jobs.updateOne(
      { _id: job._id },
      { $set: { updatedAt: new Date(NOW.getTime() - 60_000) } },
      { timestamps: false },
    );
    await materials.collection.insertOne({
      _id: materialId,
      deletedAt: null,
      title: '영어 필기',
      processing: { jobId: job._id },
    });
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    const rows = await notifications.find({ userId: me }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'note-summary', title: '노트 정리가 끝났어요' });
  });
});
