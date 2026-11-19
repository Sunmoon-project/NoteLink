import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { PATHS, QuizAttempt as SharedQuizAttempt } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { QuizAttempt } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeCollection } from './support/fake-collection.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;
const hex = () => new Types.ObjectId().toHexString();

describe('퀴즈 풀이 주소 (/api/v1/quiz-attempts)', () => {
  let app: INestApplication;
  const sets = createFakeCollection();
  const attempts = createFakeCollection();
  const users = createFakeCollection();
  // 포인트 계산(하루 한도 등)은 point-earn 테스트와 실제 DB 테스트가 본다. 여기서는 풀이 끝내기가 정답 수로 부르는지만 본다
  const earnQuiz = vi.fn((_userId: string, correctCount: number, _session?: unknown) => {
    const pts = correctCount * 4;
    (users.rows[0] as unknown as { pointBalance: number }).pointBalance += pts;
    return Promise.resolve(pts);
  });
  const me = new Types.ObjectId();
  const q1 = new Types.ObjectId();
  const q2 = new Types.ObjectId();
  let auth: { Authorization: string };

  beforeAll(async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder()
      // 트랜잭션은 가짜 연결에서 그냥 한 번 실행한다(동시성은 quiz-attempts-real-db.test.ts에서 실제 DB로 본다)
      .overrideProvider(getConnectionToken())
      .useValue({
        close: () => Promise.resolve(),
        models: {},
        model: () => ({}),
        transaction: (work: (session: unknown) => Promise<unknown>) => work({}),
      })
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(getModelToken(QuizSet.name))
      .useValue(sets.model)
      .overrideProvider(getModelToken(QuizAttempt.name))
      .useValue(attempts.model)
      .overrideProvider(getModelToken(User.name))
      .useValue(users.model)
      .overrideProvider(PointService)
      .useValue({ earnQuiz })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const { accessToken } = await moduleRef.get(TokenService).issue(me.toHexString());
    auth = { Authorization: `Bearer ${accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    sets.rows.length = 0;
    attempts.rows.length = 0;
    users.rows.length = 0;
    users.rows.push({ _id: me, pointBalance: 100 });
    earnQuiz.mockClear();
  });

  const http = () => request(app.getHttpServer());
  const addSet = async (extra: Record<string, unknown> = {}) => {
    const created = (await sets.model.create({
      ownerId: me,
      materialId: new Types.ObjectId(),
      folderId: new Types.ObjectId(),
      source: 'ai_generated',
      title: '세포 생물학',
      status: 'ready',
      deletedAt: null,
      questions: [
        { _id: q1, order: 0, type: 'short_answer', prompt: '핵에 있는 것은?', answer: 'DNA', choices: null },
        { _id: q2, order: 1, type: 'multiple_choice', prompt: '단백질을 만드는 곳은?', answer: '리보솜', choices: ['핵', '리보솜'] },
      ],
      ...extra,
    } as never)) as unknown as { _id: Types.ObjectId };
    return created._id.toHexString();
  };
  const start = async (quizSetId: string) =>
    (await http().post(api(PATHS.quizAttempts)).set(auth).send({ quizSetId }).expect(201)).body.data as {
      _id: string;
    };
  const submit = (attemptId: string, body: unknown) =>
    http().post(api(PATHS.attemptAnswer(attemptId))).set(auth).send(body as object);
  const stored = () => attempts.rows[0] as unknown as {
    correctCount: number;
    finishedAt: Date | null;
    answers: { questionId: Types.ObjectId; answer: string; correct: boolean; tries: number }[];
  };

  describe('풀이 시작 POST /quiz-attempts', () => {
    it('내 ready 세트면 201 { data }에 공용 QuizAttempt 모양으로 돌려주고 저장한다', async () => {
      const quizSetId = await addSet();
      const res = await http().post(api(PATHS.quizAttempts)).set(auth).send({ quizSetId }).expect(201);

      const attempt = res.body.data;
      expect(SharedQuizAttempt.parse(attempt)).toEqual(attempt);
      expect(attempt).toMatchObject({
        quizSetId,
        total: 2,
        correctCount: 0,
        pointsEarned: 0,
        answers: [],
        finishedAt: null,
      });
      expect(new Date(attempt.startedAt).toISOString()).toBe(attempt.startedAt);
      expect(attempts.rows).toHaveLength(1);
      expect(attempts.rows[0]).toMatchObject({ userId: me, finishedAt: null, total: 2 });
      expect(String(attempts.rows[0]!._id)).toBe(attempt._id);
    });

    it.each([['형식이 틀린 id', 'not-an-id'], ['없는 세트', hex()]])('%s는 404 NOT_FOUND', async (_name, quizSetId) => {
      const res = await http().post(api(PATHS.quizAttempts)).set(auth).send({ quizSetId }).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(attempts.rows).toHaveLength(0);
    });

    it('남의 세트와 지운 세트는 404 NOT_FOUND', async () => {
      const others = await addSet({ ownerId: new Types.ObjectId() });
      const deleted = await addSet({ deletedAt: new Date() });
      for (const quizSetId of [others, deleted]) {
        const res = await http().post(api(PATHS.quizAttempts)).set(auth).send({ quizSetId }).expect(404);
        expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(attempts.rows).toHaveLength(0);
    });

    it.each(['generating', 'failed'])('%s 세트는 400 VALIDATION_FAILED', async (status) => {
      const quizSetId = await addSet({ status });
      const res = await http().post(api(PATHS.quizAttempts)).set(auth).send({ quizSetId }).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(attempts.rows).toHaveLength(0);
    });

    it.each([[{}], [{ quizSetId: 3 }], [{ quizSetId: '' }], [{ quizSetId: hex(), extra: 1 }]])(
      '잘못된 본문 %j는 400',
      async (body) => {
        await http().post(api(PATHS.quizAttempts)).set(auth).send(body).expect(400);
        expect(attempts.rows).toHaveLength(0);
      },
    );
  });

  describe('답 제출 POST /quiz-attempts/:id/answers', () => {
    it('정답이면 { correct: true, correctAnswer }이고 풀이에 1번 푼 기록이 남는다', async () => {
      const attempt = await start(await addSet());
      const res = await submit(attempt._id, { questionId: q1.toHexString(), answer: 'DNA' }).expect(200);

      expect(res.body).toEqual({ data: { correct: true, correctAnswer: 'DNA' } });
      expect(stored().correctCount).toBe(1);
      expect(stored().answers).toHaveLength(1);
      expect(stored().answers[0]).toMatchObject({ answer: 'DNA', correct: true, tries: 1 });
      expect(String(stored().answers[0]!.questionId)).toBe(q1.toHexString());
    });

    it('오답이면 { correct: false, 정답 }이고 correctCount는 그대로 0', async () => {
      const attempt = await start(await addSet());
      const res = await submit(attempt._id, { questionId: q2.toHexString(), answer: '핵' }).expect(200);

      expect(res.body).toEqual({ data: { correct: false, correctAnswer: '리보솜' } });
      expect(stored().correctCount).toBe(0);
      expect(stored().answers[0]).toMatchObject({ answer: '핵', correct: false, tries: 1 });
    });

    it('정답은 글자 그대로 비교한다 (앞뒤 공백 · 대소문자가 다르면 오답)', async () => {
      const attempt = await start(await addSet());
      for (const answer of ['dna', ' DNA']) {
        const res = await submit(attempt._id, { questionId: q1.toHexString(), answer }).expect(200);
        expect(res.body.data.correct).toBe(false);
      }
    });

    it('같은 문제를 다시 풀면 그 항목의 answer · correct를 바꾸고 tries 2, correctCount를 다시 센다', async () => {
      const attempt = await start(await addSet());
      await submit(attempt._id, { questionId: q1.toHexString(), answer: 'RNA' }).expect(200);
      await submit(attempt._id, { questionId: q2.toHexString(), answer: '리보솜' }).expect(200);
      expect(stored().correctCount).toBe(1);

      const again = await submit(attempt._id, { questionId: q1.toHexString(), answer: 'DNA' }).expect(200);

      expect(again.body.data).toEqual({ correct: true, correctAnswer: 'DNA' });
      expect(stored().answers).toHaveLength(2);
      const first = stored().answers.find((a) => String(a.questionId) === q1.toHexString());
      expect(first).toMatchObject({ answer: 'DNA', correct: true, tries: 2 });
      expect(stored().correctCount).toBe(2);

      // 정답이던 것을 오답으로 바꾸면 다시 줄어든다
      await submit(attempt._id, { questionId: q1.toHexString(), answer: 'RNA' }).expect(200);
      expect(stored().answers.find((a) => String(a.questionId) === q1.toHexString())).toMatchObject({ tries: 3, correct: false });
      expect(stored().correctCount).toBe(1);
    });

    it('대문자 16진수 questionId로 처음 내도 200이고 정답으로 채점한다 (Codex #287)', async () => {
      const attempt = await start(await addSet());
      const res = await submit(attempt._id, { questionId: q1.toHexString().toUpperCase(), answer: 'DNA' }).expect(200);

      expect(res.body).toEqual({ data: { correct: true, correctAnswer: 'DNA' } });
      expect(stored().answers).toHaveLength(1);
      expect(String(stored().answers[0]!.questionId)).toBe(q1.toHexString());
    });

    it('같은 문제를 대문자로 한 번 · 소문자로 한 번 내도 답은 하나만 남고 tries가 오른다 (Codex #287)', async () => {
      const attempt = await start(await addSet());
      await submit(attempt._id, { questionId: q1.toHexString().toUpperCase(), answer: 'RNA' }).expect(200);
      await submit(attempt._id, { questionId: q1.toHexString(), answer: 'DNA' }).expect(200);

      expect(stored().answers).toHaveLength(1);
      expect(stored().answers[0]).toMatchObject({ answer: 'DNA', correct: true, tries: 2 });
      expect(String(stored().answers[0]!.questionId)).toBe(q1.toHexString());
      expect(stored().correctCount).toBe(1);
    });

    it('그 세트에 없는 문제는 404 NOT_FOUND이고 아무것도 저장하지 않는다', async () => {
      const attempt = await start(await addSet());
      const res = await submit(attempt._id, { questionId: hex(), answer: 'DNA' }).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(stored().answers).toHaveLength(0);
    });

    it.each([['형식이 틀린 id', 'nope'], ['없는 풀이', hex()]])('%s는 404 NOT_FOUND', async (_name, attemptId) => {
      await addSet();
      const res = await submit(attemptId, { questionId: q1.toHexString(), answer: 'DNA' }).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('남의 풀이는 404 NOT_FOUND이고 고치지 않는다', async () => {
      const quizSetId = await addSet();
      const theirs = (await attempts.model.create({
        quizSetId: new Types.ObjectId(quizSetId),
        userId: new Types.ObjectId(),
        correctCount: 0,
        total: 2,
        pointsEarned: 0,
        answers: [],
        startedAt: new Date(),
        finishedAt: null,
      } as never)) as unknown as { _id: Types.ObjectId };

      const res = await submit(theirs._id.toHexString(), { questionId: q1.toHexString(), answer: 'DNA' }).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(stored().answers).toHaveLength(0);
    });

    it('끝난 풀이는 400 VALIDATION_FAILED이고 고치지 않는다', async () => {
      const attempt = await start(await addSet());
      stored().finishedAt = new Date();

      const res = await submit(attempt._id, { questionId: q1.toHexString(), answer: 'DNA' }).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(stored().answers).toHaveLength(0);
    });

    it.each([
      [{}],
      [{ questionId: q1.toHexString() }],
      [{ answer: 'DNA' }],
      [{ questionId: 'nope', answer: 'DNA' }],
      [{ questionId: q1.toHexString(), answer: 3 }],
      [{ questionId: q1.toHexString(), answer: 'x'.repeat(2001) }],
      [{ questionId: q1.toHexString(), answer: 'DNA', extra: 1 }],
    ])('잘못된 본문 %j는 400', async (body) => {
      const attempt = await start(await addSet());
      await submit(attempt._id, body).expect(400);
      expect(stored().answers).toHaveLength(0);
    });
  });

  describe('풀이 끝내기 POST /quiz-attempts/:id/finish', () => {
    const finish = (attemptId: string) => http().post(api(PATHS.attemptFinish(attemptId))).set(auth);
    const balance = () => (users.rows[0] as unknown as { pointBalance: number }).pointBalance;
    const startWithCorrect = async (answers: string[]) => {
      const attempt = await start(await addSet());
      const ids = [q1, q2];
      for (const [i, answer] of answers.entries()) {
        await submit(attempt._id, { questionId: ids[i]!.toHexString(), answer }).expect(200);
      }
      return attempt;
    };

    it('끝내면 200 { data: { pointsEarned, balance } }, 정답 수 × 4P를 주고 finishedAt · pointsEarned를 기록한다', async () => {
      const attempt = await startWithCorrect(['DNA', '리보솜']);
      const res = await finish(attempt._id).expect(200);

      expect(res.body).toEqual({ data: { pointsEarned: 8, balance: 108 } });
      expect(earnQuiz).toHaveBeenCalledTimes(1);
      expect(earnQuiz).toHaveBeenCalledWith(me.toHexString(), 2, expect.anything());
      expect(stored().finishedAt).toBeInstanceOf(Date);
      expect((attempts.rows[0] as unknown as { pointsEarned: number }).pointsEarned).toBe(8);
    });

    it('이미 끝낸 풀이를 다시 끝내면 0P이고 잔액 그대로, 처음 기록은 바뀌지 않는다', async () => {
      const attempt = await startWithCorrect(['DNA']);
      await finish(attempt._id).expect(200);
      const firstFinishedAt = stored().finishedAt;

      const res = await finish(attempt._id).expect(200);

      expect(res.body).toEqual({ data: { pointsEarned: 0, balance: 104 } });
      expect(earnQuiz).toHaveBeenCalledTimes(1);
      expect(stored().finishedAt).toEqual(firstFinishedAt);
      expect((attempts.rows[0] as unknown as { pointsEarned: number }).pointsEarned).toBe(4);
    });

    it('정답이 0개면 0P이고 finishedAt만 기록한다', async () => {
      const attempt = await start(await addSet());
      earnQuiz.mockResolvedValueOnce(0);
      const res = await finish(attempt._id).expect(200);

      expect(res.body).toEqual({ data: { pointsEarned: 0, balance: 100 } });
      expect(stored().finishedAt).toBeInstanceOf(Date);
      expect((attempts.rows[0] as unknown as { pointsEarned: number }).pointsEarned).toBe(0);
    });

    it.each([['형식이 틀린 id', 'nope'], ['없는 풀이', hex()]])('%s는 404 NOT_FOUND', async (_name, attemptId) => {
      const res = await finish(attemptId).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(earnQuiz).not.toHaveBeenCalled();
    });

    it('남의 풀이는 404 NOT_FOUND이고 끝내지도 포인트를 주지도 않는다', async () => {
      const theirs = (await attempts.model.create({
        quizSetId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        correctCount: 2,
        total: 2,
        pointsEarned: 0,
        answers: [],
        startedAt: new Date(),
        finishedAt: null,
      } as never)) as unknown as { _id: Types.ObjectId };

      const res = await finish(theirs._id.toHexString()).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(stored().finishedAt).toBeNull();
      expect(earnQuiz).not.toHaveBeenCalled();
      expect(balance()).toBe(100);
    });

    it('끝낸 뒤 답을 내면 400 VALIDATION_FAILED', async () => {
      const attempt = await startWithCorrect(['DNA']);
      await finish(attempt._id).expect(200);

      const res = await submit(attempt._id, { questionId: q2.toHexString(), answer: '리보솜' }).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  it.each([
    ['POST', PATHS.quizAttempts],
    ['POST', PATHS.attemptAnswer(hex())],
    ['POST', PATHS.attemptFinish(hex())],
  ])('%s %s는 토큰이 없으면 401 AUTH_TOKEN_EXPIRED', async (_method, path) => {
    const res = await http().post(api(path)).send({}).expect(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });
});
