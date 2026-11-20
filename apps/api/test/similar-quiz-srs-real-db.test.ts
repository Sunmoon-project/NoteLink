// 진짜 MongoDB에서 오답 복습 결과의 복습 상태(srsUpdates) 쓰기 조건(arrayFilters의 srsAt)을 확인한다(PR #447 5차 리뷰).
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 실행마다 전용 DB를 만들고 끝나면 지운다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27017/?directConnection=true" npx vitest run test/similar-quiz-srs-real-db.test.ts
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { QuizAttempt, QuizAttemptSchema } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import {
  QuizSet,
  type QuizSetDocument,
  QuizSetSchema,
} from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { QuizSetsService } from '../src/quiz-sets/quiz-sets.service.js';
import { RecordingNotePagesService } from '../src/quiz-sets/recording-note-pages.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_similar_srs_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 오답 복습 상태 쓰기', () => {
  let moduleRef: TestingModule;
  let conn: Connection;
  let sets: Model<QuizSetDocument>;
  let service: QuizSetsService;
  const ME = new Types.ObjectId();
  const SOURCE = new Types.ObjectId();
  const Q = new Types.ObjectId();

  beforeAll(async () => {
    if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
        MongooseModule.forFeature([
          { name: QuizSet.name, schema: QuizSetSchema },
          { name: Material.name, schema: MaterialSchema },
          { name: QuizAttempt.name, schema: QuizAttemptSchema },
          { name: AiJob.name, schema: AiJobSchema },
        ]),
      ],
      providers: [QuizSetsService, AiJobsService, RecordingNotePagesService],
    }).compile();
    conn = moduleRef.get<Connection>(getConnectionToken());
    sets = moduleRef.get<Model<QuizSetDocument>>(getModelToken(QuizSet.name));
    service = moduleRef.get(QuizSetsService);
    // 복습 상태를 받을 원래 세트(문제 Q 하나)
    await conn.collection('quiz_sets').insertOne({
      _id: SOURCE,
      ownerId: ME,
      materialId: new Types.ObjectId(),
      source: 'ai_generated',
      title: '세포',
      status: 'ready',
      questionCount: 1,
      questions: [{ _id: Q, order: 1, type: 'short_answer', prompt: '?', answer: '막', srs: null }],
      deletedAt: null,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      updatedAt: new Date('2026-11-01T00:00:00Z'),
    });
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await moduleRef?.close();
  });

  /** 만든 시각이 at인 다시 보기 세트와, 문제 Q의 복습 상태를 step으로 고치는 끝난 작업 */
  const reviewSet = async (at: string, step: number) => {
    const jobId = new Types.ObjectId();
    const setId = new Types.ObjectId();
    await conn.collection('ai_jobs').insertOne({
      _id: jobId,
      userId: ME,
      type: 'similar_quiz',
      status: 'succeeded',
      progress: 100,
      targetType: 'quiz_set',
      targetId: setId.toString(),
      input: {},
      createdAt: new Date(at),
      updatedAt: new Date(at),
      result: {
        reviewQuestions: [],
        srsUpdates: [
          { quizSetId: SOURCE.toHexString(), questionId: Q.toHexString(), srs: { step } },
        ],
      },
    });
    await conn.collection('quiz_sets').insertOne({
      _id: setId,
      ownerId: ME,
      // 만드는 중인 세트는 노트마다 하나(고유 색인)라 세트마다 다른 노트로 둔다
      materialId: new Types.ObjectId(),
      sourceSetId: SOURCE,
      source: 'ai_generated',
      title: '세포 · 다시 보기',
      status: 'generating',
      questionCount: 0,
      questions: [],
      jobId,
      srsSavedAt: null,
      deletedAt: null,
      createdAt: new Date(at),
      updatedAt: new Date(at),
    });
    return setId.toHexString();
  };
  const stepOfQ = async () =>
    ((await sets.findById(SOURCE).lean())!.questions[0]!.srs as { step: number } | null)?.step;
  const setOf = (id: string) => sets.findById(id).lean();
  /** 문제 Q의 복습 상태를 비운다(앞 테스트가 남긴 srs · srsAt) */
  const resetQ = () =>
    sets.updateOne(
      { _id: SOURCE },
      { $set: { 'questions.0.srs': null }, $unset: { 'questions.0.srsAt': 1 } },
    );
  /**
   * 서비스의 첫 복습 상태 쓰기(updateOne) 하나를 붙잡아 둔다. arrived: 붙잡혔을 때, release(true): 그대로 쓴다,
   * release(false): 실패시킨다. 나머지 쓰기는 바로 지나간다
   */
  const holdFirstWrite = () => {
    const original = sets.updateOne.bind(sets);
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>((r) => (release = r));
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    let held = false;
    const spy = vi.spyOn(sets, 'updateOne').mockImplementation(((
      ...args: Parameters<typeof sets.updateOne>
    ) => {
      if (held) return original(...args);
      held = true;
      reached();
      return gate.then(async (ok) => {
        if (!ok) throw new Error('DB 끊김');
        return original(...args);
      });
    }) as never);
    return { arrived, release, restore: () => spy.mockRestore() };
  };

  it('늦게 옮긴 오래된 세트(A)는 더 새 세트(B)가 쓴 상태를 되돌리지 않는다', async () => {
    const a = await reviewSet('2026-11-10T00:00:00Z', 1);
    const b = await reviewSet('2026-11-12T00:00:00Z', 2);
    await service.findMine(ME.toHexString(), b);
    expect(await stepOfQ()).toBe(2);
    // A의 쓰기가 늦게 도착한 경우: B보다 오래됐으므로 조건에 걸려 쓰지 않는다
    await service.findMine(ME.toHexString(), a);
    expect(await stepOfQ()).toBe(2);
    // 그 뒤에 만든 세트는 쓴다
    const c = await reviewSet('2026-11-14T00:00:00Z', 3);
    await service.findMine(ME.toHexString(), c);
    expect(await stepOfQ()).toBe(3);
    // 같은 세트가 다시 써도(동시 조회 · 실패 뒤 재시도) 같은 값
    await sets.updateOne(
      { _id: new Types.ObjectId(c) },
      { $set: { srsSavedAt: null, status: 'generating' } },
    );
    await service.findMine(ME.toHexString(), c);
    expect(await stepOfQ()).toBe(3);
  });

  it('A의 첫 쓰기가 멈춘 사이 다른 조회가 A를 끝내고 B가 반영된 뒤 A 쓰기가 재개돼도 B가 남는다', async () => {
    await resetQ();
    const a = await reviewSet('2026-11-20T00:00:00Z', 1);
    const b = await reviewSet('2026-11-22T00:00:00Z', 2);
    const hold = holdFirstWrite();
    try {
      const first = service.findMine(ME.toHexString(), a);
      await hold.arrived;
      // 둘째 조회가 A를 다 옮기고 세트를 바꾼다
      await service.findMine(ME.toHexString(), a);
      expect(await stepOfQ()).toBe(1);
      expect((await setOf(a))!.srsSavedAt).toBeInstanceOf(Date);
      // B를 옮긴다
      await service.findMine(ME.toHexString(), b);
      expect(await stepOfQ()).toBe(2);
      // 멈췄던 A의 첫 쓰기가 이제 도착해도 B보다 오래돼 쓰지 않는다
      hold.release(true);
      await first;
      expect(await stepOfQ()).toBe(2);
    } finally {
      hold.restore();
    }
  });

  it('다른 조회가 A를 끝낸 뒤 A의 첫 쓰기가 실패해도 복습 상태는 남아 있다', async () => {
    await resetQ();
    const a = await reviewSet('2026-11-24T00:00:00Z', 4);
    const hold = holdFirstWrite();
    try {
      const first = service.findMine(ME.toHexString(), a);
      await hold.arrived;
      await service.findMine(ME.toHexString(), a);
      hold.release(false);
      await expect(first).rejects.toThrow('DB 끊김');
      expect(await stepOfQ()).toBe(4);
      expect((await setOf(a))!.srsSavedAt).toBeInstanceOf(Date);
    } finally {
      hold.restore();
    }
  });

  it('혼자 옮기던 A의 쓰기가 실패하면 세트 · 표시가 그대로라 다음 조회가 다시 옮긴다', async () => {
    await resetQ();
    const a = await reviewSet('2026-11-26T00:00:00Z', 5);
    const hold = holdFirstWrite();
    try {
      const first = service.findMine(ME.toHexString(), a);
      await hold.arrived;
      hold.release(false);
      await expect(first).rejects.toThrow('DB 끊김');
    } finally {
      hold.restore();
    }
    expect(await stepOfQ()).toBeUndefined();
    expect(await setOf(a)).toMatchObject({ status: 'generating', srsSavedAt: null });
    await service.findMine(ME.toHexString(), a);
    expect(await stepOfQ()).toBe(5);
    expect((await setOf(a))!.srsSavedAt).toBeInstanceOf(Date);
  });
  it('오답 복습 결과를 옮기면 퀴즈를 끝낼 때 남긴 처음 상태 표시(srsAttemptId, FR-37)를 지운다', async () => {
    await resetQ();
    await sets.updateOne(
      { _id: SOURCE },
      {
        $set: {
          'questions.0.srsAttemptId': new Types.ObjectId(),
          'questions.0.srsAt': new Date('2026-11-01T00:00:00Z'),
        },
      },
    );
    const a = await reviewSet('2026-11-26T00:00:00Z', 1);
    await service.findMine(ME.toHexString(), a);
    const q = (await sets.findById(SOURCE).lean())!.questions[0]!;
    expect(q.srsAttemptId).toBeUndefined();
    expect(await stepOfQ()).toBe(1);
  });
});
