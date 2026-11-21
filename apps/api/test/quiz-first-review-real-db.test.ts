// 진짜 MongoDB에서 퀴즈를 끝내면 복습 일정에 들어가는지(FR-37, 퀴즈 → 복습 이어 주기) 보는 테스트.
// 확인하는 것: 처음 끝낼 때 복습 상태가 없는 푼 문제에만 처음 복습 상태(처리기 srs.py와 같은 값)를 쓰고, 응답에
// scheduled · nextReviewDay를 담는다 · 이미 복습 중인 문제 · 안 푼 문제 · 노트 없는 세트는 그대로 · 다시 끝내면 그대로 ·
// 다음 날 복습 알림(#566)이 그 문제를 센다 · 그 풀이로 오답 복습을 만들 때 처리기에는 복습 상태 없이 넘긴다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection, type Model } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import {
  PointLedger,
  PointLedgerSchema,
} from '../src/modules/reward/schemas/point-ledger.schema.js';
import { QuizAttemptsService } from '../src/modules/quiz/quiz-attempts.service.js';
import { QuizAttempt, QuizAttemptSchema } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { firstReview } from '../src/quiz-sets/first-review.js';
import { reviewInputQuestion } from '../src/quiz-sets/quiz-sets.service.js';
import { ReviewRemindersService } from '../src/review-reminders/review-reminders.service.js';
import { seoulDate } from '../src/modules/session/study-time.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_first_review_${process.pid}_${Date.now()}`;

type Q = {
  _id: Types.ObjectId;
  order: number;
  prompt: string;
  answer: string;
  srs?: Record<string, unknown> | null;
  srsAt?: Date;
  srsAttemptId?: Types.ObjectId;
};

describe.skipIf(!isLocal)('진짜 DB 퀴즈를 끝내면 복습 일정에 넣기', () => {
  let moduleRef: TestingModule;
  let conn: Connection;
  let service: QuizAttemptsService;
  let seq = 0;
  const col = (name: string) => conn.collection(name);

  beforeAll(async () => {
    if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
        MongooseModule.forFeature([
          { name: QuizAttempt.name, schema: QuizAttemptSchema },
          { name: QuizSet.name, schema: QuizSetSchema },
          { name: User.name, schema: UserSchema },
          { name: PointLedger.name, schema: PointLedgerSchema },
        ]),
      ],
      providers: [QuizAttemptsService, PointService],
    }).compile();
    await moduleRef.init();
    conn = moduleRef.get<Connection>(getConnectionToken());
    await conn.dropDatabase();
    await Promise.all(
      [QuizAttempt.name, QuizSet.name, User.name, PointLedger.name].map((n) =>
        conn.model(n).init(),
      ),
    );
    service = moduleRef.get(QuizAttemptsService);
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    await moduleRef?.close();
  });

  const newUser = async () => {
    const id = new Types.ObjectId();
    await col('users').insertOne({ _id: id, nickname: `first-review-${seq++}`, pointBalance: 0 });
    return id;
  };
  const question = (i: number, extra: Partial<Q> = {}): Q => ({
    _id: new Types.ObjectId(),
    order: i,
    prompt: `q${i}`,
    answer: 'A',
    ...extra,
  });
  const newSet = async (
    owner: Types.ObjectId,
    qs: Q[],
    materialId: Types.ObjectId | null = new Types.ObjectId(),
  ) =>
    (
      await col('quiz_sets').insertOne({
        ownerId: owner,
        materialId,
        status: 'ready',
        deletedAt: null,
        questions: qs,
      })
    ).insertedId;
  const solve = async (owner: Types.ObjectId, setId: Types.ObjectId, picks: [Q, string][]) => {
    const started = await service.start(owner.toString(), setId.toString());
    for (const [q, a] of picks)
      await service.answer(owner.toString(), started._id, q._id.toString(), a);
    return started._id;
  };
  const questionsOf = async (setId: Types.ObjectId) =>
    ((await col('quiz_sets').findOne({ _id: setId })) as unknown as { questions: Q[] }).questions;
  const finishedAtOf = async (attemptId: string) =>
    (
      (await col('quiz_attempts').findOne({ _id: new Types.ObjectId(attemptId) })) as unknown as {
        finishedAt: Date;
      }
    ).finishedAt;

  it('처음 끝내면 푼 문제(맞힘 · 틀림)에 처리기와 같은 처음 복습 상태를 쓰고, 넣은 수와 다음 복습 날짜를 돌려준다', async () => {
    const me = await newUser();
    const [right, wrong] = [question(0), question(1)];
    const setId = await newSet(me, [right, wrong]);
    const attemptId = await solve(me, setId, [
      [right, 'A'],
      [wrong, 'X'],
    ]);

    const res = await service.finish(me.toString(), attemptId);

    const at = await finishedAtOf(attemptId);
    const [r, w] = await questionsOf(setId);
    expect(r!.srs).toEqual(firstReview(true, at));
    expect(w!.srs).toEqual(firstReview(false, at));
    expect(r!.srsAt).toEqual(at);
    expect(w!.srsAttemptId?.toString()).toBe(attemptId);
    expect(res).toMatchObject({
      scheduled: 2,
      nextReviewDay: seoulDate(firstReview(true, at).dueAt as Date),
    });
  });

  it('이미 복습 중인 문제 · 풀지 않은 문제는 그대로 두고, 새로 넣은 문제만 센다', async () => {
    const me = await newUser();
    const keep = {
      step: 2,
      dueAt: new Date('2026-12-01T15:00:00Z'),
      state: 'active',
      reviews: 3,
      streak: 1,
    };
    const [old, fresh, skipped] = [question(0, { srs: keep }), question(1), question(2)];
    const setId = await newSet(me, [old, fresh, skipped]);
    const attemptId = await solve(me, setId, [
      [old, 'X'],
      [fresh, 'X'],
    ]);

    const res = await service.finish(me.toString(), attemptId);

    const [o, f, s] = await questionsOf(setId);
    expect(o!.srs).toEqual(keep);
    expect(o!.srsAttemptId).toBeUndefined();
    expect(f!.srs).toMatchObject({ state: 'active', lastResult: 'wrong', reviews: 1 });
    expect(s!.srs ?? null).toBeNull();
    expect(res.scheduled).toBe(1);
  });

  it('이미 끝낸 풀이를 다시 끝내면 복습 상태를 다시 쓰지 않고 0을 돌려준다', async () => {
    const me = await newUser();
    const q = question(0);
    const setId = await newSet(me, [q]);
    const attemptId = await solve(me, setId, [[q, 'X']]);
    await service.finish(me.toString(), attemptId);
    const before = await questionsOf(setId);

    const again = await service.finish(me.toString(), attemptId);

    expect(again).toMatchObject({ scheduled: 0, nextReviewDay: null });
    expect(await questionsOf(setId)).toEqual(before);
  });

  it('노트가 없는 세트는 오늘의 복습 · 알림이 고르지 않으므로 넣지 않는다(0, 날짜 없음)', async () => {
    const me = await newUser();
    const q = question(0);
    const setId = await newSet(me, [q], null);
    const attemptId = await solve(me, setId, [[q, 'X']]);

    const res = await service.finish(me.toString(), attemptId);

    expect(res).toMatchObject({ scheduled: 0, nextReviewDay: null });
    expect((await questionsOf(setId))[0]!.srs ?? null).toBeNull();
  });

  it('넣은 문제는 다음 날(서울) 복습 알림(#566) 집계에 들고, 끝낸 그날에는 들지 않는다', async () => {
    const me = await newUser();
    const qs = [question(0), question(1)];
    const setId = await newSet(me, qs);
    const attemptId = await solve(me, setId, [
      [qs[0]!, 'A'],
      [qs[1]!, 'X'],
    ]);
    const res = await service.finish(me.toString(), attemptId);
    const reminders = new ReviewRemindersService(
      conn.model(QuizSet.name) as Model<QuizSet>,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    ) as unknown as { countDue(userId: Types.ObjectId, day: string): Promise<number> };

    expect(await reminders.countDue(me, res.nextReviewDay!)).toBe(2);
    expect(await reminders.countDue(me, seoulDate(await finishedAtOf(attemptId)))).toBe(0);
  });

  it('그 풀이로 오답 복습을 만들 때는 처리기에 복습 상태 없이 넘긴다(같은 풀이를 두 번 세지 않게)', async () => {
    const me = await newUser();
    const q = question(0);
    const setId = await newSet(me, [q]);
    const attemptId = await solve(me, setId, [[q, 'A']]);
    await service.finish(me.toString(), attemptId);
    const [stored] = (await questionsOf(setId)) as never as Parameters<
      typeof reviewInputQuestion
    >[0][];

    expect(reviewInputQuestion(stored!, new Types.ObjectId(attemptId)).srs).toBeNull();
    expect(reviewInputQuestion(stored!, new Types.ObjectId()).srs).toMatchObject({ reviews: 1 });
  });
});
