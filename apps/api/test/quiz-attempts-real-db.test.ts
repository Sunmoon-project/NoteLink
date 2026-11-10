// 진짜 MongoDB(replica set)에서 같은 풀이 · 같은 문제에 답이 거의 동시에 들어와도 답이 하나만 남는지 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 파일·실행마다 고유한 전용 DB(notelink_verify_quiz_attempts_<pid>_<시각>)만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/quiz-attempts-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { QuizAttemptsService } from '../src/modules/quiz/quiz-attempts.service.js';
import { QuizAttempt, QuizAttemptSchema } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_quiz_attempts_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 퀴즈 답 동시 제출 확인', () => {
    let moduleRef: TestingModule;
    let conn: Connection;
    let service: QuizAttemptsService;
    const col = (name: string) => conn.collection(name);

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        moduleRef = await Test.createTestingModule({
            imports: [
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: QuizAttempt.name, schema: QuizAttemptSchema },
                    { name: QuizSet.name, schema: QuizSetSchema },
                ]),
            ],
            providers: [QuizAttemptsService],
        }).compile();
        await moduleRef.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        // 트랜잭션 안에서 컬렉션이 처음 만들어지는 일이 없도록 미리 만들어 둔다
        await Promise.all([conn.model(QuizAttempt.name).init(), conn.model(QuizSet.name).init()]);
        service = moduleRef.get(QuizAttemptsService);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await moduleRef?.close();
    });

    it('같은 문제에 답을 동시에 3번 내도 answers에 그 문제가 하나만 남고 tries가 3이 된다', async () => {
        const me = new Types.ObjectId();
        const q1 = new Types.ObjectId();
        const set = await col('quiz_sets').insertOne({
            ownerId: me,
            status: 'ready',
            deletedAt: null,
            questions: [{ _id: q1, order: 0, prompt: '핵에 있는 것은?', answer: 'DNA' }],
        });
        const started = await service.start(me.toString(), set.insertedId.toString());

        const results = await Promise.all(
            ['RNA', 'DNA', 'DNA'].map((answer) => service.answer(me.toString(), started._id, q1.toString(), answer)),
        );

        expect(results.map((r) => r.correctAnswer)).toEqual(['DNA', 'DNA', 'DNA']);
        const row = (await col('quiz_attempts').findOne({ _id: new Types.ObjectId(started._id) })) as unknown as {
            correctCount: number;
            answers: { questionId: Types.ObjectId; tries: number; correct: boolean }[];
        };
        expect(row.answers).toHaveLength(1);
        expect(row.answers[0]!.tries).toBe(3);
        expect(row.correctCount).toBe(row.answers[0]!.correct ? 1 : 0);
    });

    it('서로 다른 문제에 동시에 답해도 둘 다 남고 correctCount가 맞다', async () => {
        const me = new Types.ObjectId();
        const [q1, q2] = [new Types.ObjectId(), new Types.ObjectId()];
        const set = await col('quiz_sets').insertOne({
            ownerId: me,
            status: 'ready',
            deletedAt: null,
            questions: [
                { _id: q1, order: 0, prompt: 'a', answer: 'A' },
                { _id: q2, order: 1, prompt: 'b', answer: 'B' },
            ],
        });
        const started = await service.start(me.toString(), set.insertedId.toString());

        await Promise.all([
            service.answer(me.toString(), started._id, q1.toString(), 'A'),
            service.answer(me.toString(), started._id, q2.toString(), 'B'),
        ]);

        const row = (await col('quiz_attempts').findOne({ _id: new Types.ObjectId(started._id) })) as unknown as {
            correctCount: number;
            answers: unknown[];
        };
        expect(row.answers).toHaveLength(2);
        expect(row.correctCount).toBe(2);
    });
});
