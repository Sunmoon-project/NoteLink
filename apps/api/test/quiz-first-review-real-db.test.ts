// 진짜 MongoDB에서 퀴즈를 끝내면 복습 일정에 들어가는지(FR-37, 퀴즈 → 복습 이어 주기) 보는 테스트.
// 확인하는 것: 처음 끝낼 때 복습 상태가 없는 푼 문제에 처음 복습 상태(처리기 srs.py와 같은 값)를 쓰고, 응답에
// scheduled · nextReviewDay를 담는다 · 안 푼 문제 · 노트 없는 세트는 그대로 · 다시 끝내면 그대로 ·
// 다음 날 복습 알림(#566)이 그 문제를 센다 · 그 풀이로 오답 복습을 만들 때 처리기에는 복습 상태 없이 넘긴다.
// 자동 오답 복습이 꺼져 있으면(기본, #625) 이미 복습 중인 문제도 다음 상태(srs.py update)로 옮기고, 켜져 있으면 그대로 둔다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection, type Model } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import {
  PointLedger,
  PointLedgerSchema,
} from '../src/modules/reward/schemas/point-ledger.schema.js';
import { QuizAttemptsService } from '../src/modules/quiz/quiz-attempts.service.js';
import { QuizAttempt, QuizAttemptSchema } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { firstReview, nextReview } from '../src/quiz-sets/first-review.js';
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
  checked?: boolean;
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

  afterEach(() => {
    vi.unstubAllEnvs();
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
    extra: Record<string, unknown> = {},
  ) =>
    (
      await col('quiz_sets').insertOne({
        ownerId: owner,
        materialId,
        status: 'ready',
        deletedAt: null,
        questions: qs,
        ...extra,
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

  it('자동 오답 복습이 켜져 있으면 이미 복습 중인 문제 · 풀지 않은 문제는 그대로 두고, 새로 넣은 문제만 센다', async () => {
    vi.stubEnv('AUTO_SIMILAR_ON_FINISH', 'true');
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

  describe('자동 오답 복습이 꺼져 있으면(기본, #625) 퀴즈를 끝낼 때 복습 상태를 LLM 없이 옮긴다', () => {
    const due = new Date('2026-11-01T15:00:00Z');
    const active = (reviews: number, extra: Record<string, unknown> = {}) => ({
      step: 0,
      dueAt: due,
      lastResult: 'wrong',
      streak: 0,
      reviews,
      state: 'active',
      ...extra,
    });
    /** 한 문제 세트를 풀고 끝낸 뒤 그 문제의 복습 상태 */
    const round = async (me: Types.ObjectId, setId: Types.ObjectId, q: Q, answer: string) => {
      const attemptId = await solve(me, setId, [[q, answer]]);
      const res = await service.finish(me.toString(), attemptId);
      const stored = (await questionsOf(setId)).find((x) => x._id.equals(q._id))!;
      return { res, stored, at: await finishedAtOf(attemptId) };
    };

    it('처음 → 1일, 다음에 또 맞히면 연속 2번이라 다 익힘(날짜 없음, 일정에서 빠짐)', async () => {
      const me = await newUser();
      const q = question(0);
      const setId = await newSet(me, [q]);
      const one = await round(me, setId, q, 'A');
      expect(one.stored.srs).toEqual(firstReview(true, one.at));
      expect(one.res).toMatchObject({
        scheduled: 1,
        nextReviewDay: seoulDate(firstReview(true, one.at).dueAt as Date),
      });

      const two = await round(me, setId, q, 'A');
      expect(two.stored.srs).toEqual(nextReview(one.stored.srs!, true, two.at));
      expect(two.stored.srs).toMatchObject({
        state: 'mastered',
        dueAt: null,
        streak: 2,
        reviews: 2,
        endedAt: two.at,
      });
      expect(two.stored.srsAt).toEqual(two.at);
      expect(two.stored.srsAttemptId).toBeUndefined();
      expect(two.res).toMatchObject({ scheduled: 0, nextReviewDay: null });
    });

    it('틀리면 step 0 · 연속 0 · 다음 날, 5번째 풀이에서 못 익혔으면 그만(stopped)', async () => {
      const me = await newUser();
      const q = question(0, { srs: active(3, { step: 1, streak: 1, lastResult: 'right' }) });
      const setId = await newSet(me, [q]);
      const wrong = await round(me, setId, q, 'X');
      expect(wrong.stored.srs).toMatchObject({
        step: 0,
        streak: 0,
        reviews: 4,
        state: 'active',
        lastResult: 'wrong',
      });
      expect(wrong.res.nextReviewDay).toBe(seoulDate(firstReview(false, wrong.at).dueAt as Date));

      const fifth = await round(me, setId, q, 'X');
      expect(fifth.stored.srs).toMatchObject({
        reviews: 5,
        state: 'stopped',
        dueAt: null,
        endedAt: fifth.at,
      });
      expect(fifth.res).toMatchObject({ scheduled: 0, nextReviewDay: null });
    });

    it('오늘의 복습 사본(노트를 받은 오늘의 복습 세트)을 풀면 그 사본의 복습 상태를 옮긴다', async () => {
      const me = await newUser();
      const copy = question(0, { srs: active(1, { checked: true }) });
      const setId = await newSet(me, [copy], new Types.ObjectId(), {
        reviewDay: '2026-11-02',
        title: '오늘의 복습 · 11-02',
      });
      const r = await round(me, setId, copy, 'A');
      expect(r.stored.srs).toEqual(nextReview(copy.srs!, true, r.at));
      expect(r.stored.srs).toMatchObject({ step: 1, streak: 1, reviews: 2, checked: true });
      expect(r.res.scheduled).toBe(1);
    });

    it('무효 답(결함 문제)은 없는 풀이로 보고 그 문제의 복습 상태는 그대로 둔다', async () => {
      const me = await newUser();
      const [flawed, ok] = [question(0, { srs: active(1) }), question(1, { srs: active(1) })];
      const setId = await newSet(me, [flawed, ok]);
      const attemptId = await solve(me, setId, [
        [flawed, 'X'],
        [ok, 'A'],
      ]);
      await col('quiz_attempts').updateOne(
        { _id: new Types.ObjectId(attemptId) },
        { $set: { 'answers.$[a].void': '정답 둘' } },
        { arrayFilters: [{ 'a.questionId': flawed._id }] },
      );
      await service.finish(me.toString(), attemptId);
      const [f, o] = await questionsOf(setId);
      expect(f!.srs).toEqual(active(1));
      expect(o!.srs).toMatchObject({ reviews: 2, streak: 1 });
    });

    it('같은 풀이를 두 번 끝내도 한 번만 옮긴다', async () => {
      const me = await newUser();
      const q = question(0, { srs: active(1) });
      const setId = await newSet(me, [q]);
      const attemptId = await solve(me, setId, [[q, 'A']]);
      await service.finish(me.toString(), attemptId);
      const once = await questionsOf(setId);
      expect(await service.finish(me.toString(), attemptId)).toMatchObject({
        scheduled: 0,
        nextReviewDay: null,
      });
      expect(await questionsOf(setId)).toEqual(once);
      expect(once[0]!.srs).toMatchObject({ reviews: 2 });
    });

    it('그 상태를 이 풀이보다 늦게 쓴 문제(srsAt)는 그대로 둔다', async () => {
      const me = await newUser();
      const q = question(0, { srs: active(1), srsAt: new Date(Date.now() + 60 * 60 * 1000) });
      const setId = await newSet(me, [q]);
      const r = await round(me, setId, q, 'A');
      expect(r.stored.srs).toEqual(active(1));
      expect(r.res).toMatchObject({ scheduled: 0, nextReviewDay: null });
    });

    it('만들 때 검사를 통과한 문제(checked)는 처음 상태에 checked를 넣고, 표시가 없는 옛 문제는 넣지 않는다', async () => {
      const me = await newUser();
      const [checked, old] = [question(0, { checked: true }), question(1)];
      const setId = await newSet(me, [checked, old]);
      const attemptId = await solve(me, setId, [
        [checked, 'A'],
        [old, 'A'],
      ]);
      await service.finish(me.toString(), attemptId);
      const at = await finishedAtOf(attemptId);
      const [c, o] = await questionsOf(setId);
      expect(c!.srs).toEqual(firstReview(true, at, true));
      expect(o!.srs).toEqual(firstReview(true, at));
    });
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
