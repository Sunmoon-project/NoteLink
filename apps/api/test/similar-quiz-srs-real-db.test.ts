// 진짜 MongoDB에서 오답 복습 결과의 복습 상태(srsUpdates) 쓰기 조건(arrayFilters의 srsAt)을 확인한다(PR #447 5차 리뷰).
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 실행마다 전용 DB를 만들고 끝나면 지운다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27017/?directConnection=true" npx vitest run test/similar-quiz-srs-real-db.test.ts
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
      providers: [QuizSetsService, AiJobsService],
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
});
