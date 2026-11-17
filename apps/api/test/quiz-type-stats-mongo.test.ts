import mongoose, { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuizAttempt, QuizAttemptSchema } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSetsService } from '../src/quiz-sets/quiz-sets.service.js';

const uri = process.env.TYPE_STATS_TEST_URI;
const suite = uri ? describe : describe.skip;
suite('MongoDB 전체 유형별 통계', () => {
  let connection: Connection;
  let service: QuizSetsService;
  const setId = new Types.ObjectId();
  const deletedId = new Types.ObjectId();
  const q1 = new Types.ObjectId();
  const q2 = new Types.ObjectId();
  const attemptIds: Types.ObjectId[] = [];
  beforeAll(async () => {
    connection = await mongoose.createConnection(uri!).asPromise();
    const attempts = connection.model(QuizAttempt.name, QuizAttemptSchema);
    service = new QuizSetsService({} as never, {} as never, attempts as never, {} as never);
    await connection.collection('quiz_sets').insertMany([
      {
        _id: setId,
        status: 'ready',
        deletedAt: null,
        questions: [
          { _id: q1, category: '조합' },
          { _id: q2, category: '정의' },
        ],
      },
      {
        _id: deletedId,
        status: 'ready',
        deletedAt: new Date(),
        questions: [{ _id: q1, category: '조합' }],
      },
    ]);
    const make = (over: Record<string, unknown>) => {
      const _id = new Types.ObjectId();
      attemptIds.push(_id);
      return {
        _id,
        quizSetId: setId,
        userId: new Types.ObjectId(),
        finishedAt: new Date(),
        ...over,
      };
    };
    await connection.collection('quiz_attempts').insertMany([
      make({
        answers: [
          { questionId: q1, correct: true },
          { questionId: q1, correct: true },
          { questionId: q2, correct: false },
        ],
      }),
      make({
        answers: [
          { questionId: q1, correct: false },
          { questionId: q1, correct: true, void: true },
          { questionId: q2, correct: true, void: '취소' },
        ],
      }),
      make({ finishedAt: null, answers: [{ questionId: q1, correct: true }] }),
      make({ quizSetId: deletedId, answers: [{ questionId: q1, correct: true }] }),
      make({
        answers: [
          { questionId: new Types.ObjectId(), correct: true },
          { questionId: q1, correct: 'true' },
        ],
      }),
    ]);
  });
  afterAll(async () => {
    if (!connection) return;
    await connection.collection('quiz_attempts').deleteMany({ _id: { $in: attemptIds } });
    await connection.collection('quiz_sets').deleteMany({ _id: { $in: [setId, deletedId] } });
    await connection.close();
  });
  it('여러 사용자의 유효한 완료 답안만 문제 유형별로 센다', async () => {
    expect(await service['readTypeStats']()).toEqual({
      조합: { answered: 2, correct: 1 },
      정의: { answered: 1, correct: 0 },
    });
  });
});
