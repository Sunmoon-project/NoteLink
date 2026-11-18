// 진짜 MongoDB(replica set)에서 (1) 같은 풀이 · 같은 문제에 답이 거의 동시에 들어와도 답이 하나만 남는지, (2) 풀이 끝내기가 포인트를 한 번만 주는지 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 파일·실행마다 고유한 전용 DB(notelink_verify_quiz_attempts_<pid>_<시각>)만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/quiz-attempts-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { seoulDay } from '../src/modules/reward/point/point-rules.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger, PointLedgerSchema } from '../src/modules/reward/schemas/point-ledger.schema.js';
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
                    { name: User.name, schema: UserSchema },
                    { name: PointLedger.name, schema: PointLedgerSchema },
                ]),
            ],
            providers: [QuizAttemptsService, PointService],
        }).compile();
        await moduleRef.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        // 트랜잭션 안에서 컬렉션이 처음 만들어지는 일이 없도록 미리 만들어 둔다
        await Promise.all([
            conn.model(QuizAttempt.name).init(),
            conn.model(QuizSet.name).init(),
            conn.model(User.name).init(),
            conn.model(PointLedger.name).init(),
        ]);
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

    describe('풀이 끝내기 finish', () => {
        let nicknameSeq = 0;
        // users는 nickname 유일 인덱스가 있어서 사람마다 다른 닉네임을 넣는다. 잔액은 100
        const newUser = async (): Promise<Types.ObjectId> => {
            const userId = new Types.ObjectId();
            await col('users').insertOne({ _id: userId, nickname: `finish-user-${nicknameSeq++}`, pointBalance: 100 });
            return userId;
        };
        const balanceOf = async (userId: Types.ObjectId): Promise<number> =>
            ((await col('users').findOne({ _id: userId })) as unknown as { pointBalance: number }).pointBalance;
        const ledgerOf = (userId: Types.ObjectId) => col('point_ledgers').find({ userId }).toArray();
        const rowOf = (attemptId: string) =>
            col('quiz_attempts').findOne({ _id: new Types.ObjectId(attemptId) }) as unknown as Promise<{
                finishedAt: Date | null;
                pointsEarned: number;
            }>;
        // 문제 count개짜리 세트에서 앞의 correct개를 맞힌 풀이를 만들어 돌려준다
        const attemptWith = async (userId: Types.ObjectId, correct: number, count = correct) => {
            const qs = Array.from({ length: count }, (_, i) => ({ _id: new Types.ObjectId(), order: i, prompt: `q${i}`, answer: 'A' }));
            const set = await col('quiz_sets').insertOne({ ownerId: userId, status: 'ready', deletedAt: null, questions: qs });
            const started = await service.start(userId.toString(), set.insertedId.toString());
            for (const [i, q] of qs.entries()) {
                await service.answer(userId.toString(), started._id, q._id.toString(), i < correct ? 'A' : 'X');
            }
            return { id: started._id, questions: qs };
        };

        it('끝내면 정답 수 × 4P를 주고 finishedAt · pointsEarned를 기록하고 잔액이 늘며 장부에 한 줄이 남는다', async () => {
            const me = await newUser();
            const attempt = await attemptWith(me, 3, 4);

            const result = await service.finish(me.toString(), attempt.id);

            expect(result).toEqual({ pointsEarned: 12, balance: 112 });
            expect(await balanceOf(me)).toBe(112);
            const row = await rowOf(attempt.id);
            expect(row.finishedAt).toBeInstanceOf(Date);
            expect(row.pointsEarned).toBe(12);
            const ledger = await ledgerOf(me);
            expect(ledger).toHaveLength(1);
            expect(ledger[0]).toMatchObject({ amount: 12, balanceAfter: 112, reasonType: 'quiz_correct' });
        });

        it('이미 끝낸 풀이를 다시 끝내면 0P이고 잔액 · 장부 · 처음 기록이 그대로다', async () => {
            const me = await newUser();
            const attempt = await attemptWith(me, 2);
            await service.finish(me.toString(), attempt.id);
            const first = await rowOf(attempt.id);

            const again = await service.finish(me.toString(), attempt.id);

            expect(again).toEqual({ pointsEarned: 0, balance: 108 });
            expect(await balanceOf(me)).toBe(108);
            expect(await ledgerOf(me)).toHaveLength(1);
            expect(await rowOf(attempt.id)).toEqual(first);
        });

        it('같은 풀이를 동시에 두 번 끝내도 포인트는 한 번만 들어간다', async () => {
            const me = await newUser();
            const attempt = await attemptWith(me, 3);

            const results = await Promise.all([service.finish(me.toString(), attempt.id), service.finish(me.toString(), attempt.id)]);

            expect(results.map((r) => r.pointsEarned).sort()).toEqual([0, 12]);
            expect(await balanceOf(me)).toBe(112);
            expect(await ledgerOf(me)).toHaveLength(1);
            expect((await rowOf(attempt.id)).pointsEarned).toBe(12);
        });

        it('하루 40P 한도: 오늘 이미 36P를 받았으면 4P만 받는다', async () => {
            const me = await newUser();
            await col('users').updateOne({ _id: me }, { $set: { pointBalance: 136 } });
            await col('point_ledgers').insertOne({
                userId: me,
                amount: 36,
                balanceAfter: 136,
                reasonType: 'quiz_correct',
                studyDate: seoulDay(new Date()),
                description: '앞서 받은 퀴즈 포인트',
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            const attempt = await attemptWith(me, 5);

            const result = await service.finish(me.toString(), attempt.id);

            expect(result).toEqual({ pointsEarned: 4, balance: 140 });
            expect((await rowOf(attempt.id)).pointsEarned).toBe(4);
            expect(await ledgerOf(me)).toHaveLength(2);
        });

        it('정답이 0개면 0P이고 장부에 기록이 없다(끝난 것으로는 기록한다)', async () => {
            const me = await newUser();
            const attempt = await attemptWith(me, 0, 2);

            const result = await service.finish(me.toString(), attempt.id);

            expect(result).toEqual({ pointsEarned: 0, balance: 100 });
            expect(await ledgerOf(me)).toHaveLength(0);
            const row = await rowOf(attempt.id);
            expect(row.finishedAt).toBeInstanceOf(Date);
            expect(row.pointsEarned).toBe(0);
        });

        it('남의 풀이 · 없는 풀이 · 잘못된 id는 404이고 아무것도 바뀌지 않는다', async () => {
            const me = await newUser();
            const other = await newUser();
            const theirs = await attemptWith(other, 2);

            for (const id of [theirs.id, new Types.ObjectId().toString(), 'not-an-id']) {
                await expect(service.finish(me.toString(), id)).rejects.toMatchObject({ status: 404 });
            }
            expect((await rowOf(theirs.id)).finishedAt).toBeNull();
            expect(await balanceOf(other)).toBe(100);
            expect(await ledgerOf(other)).toHaveLength(0);
        });

        it('끝낸 뒤 답을 내면 400이다', async () => {
            const me = await newUser();
            const attempt = await attemptWith(me, 1, 2);
            await service.finish(me.toString(), attempt.id);

            await expect(
                service.answer(me.toString(), attempt.id, attempt.questions[1]!._id.toString(), 'A'),
            ).rejects.toMatchObject({ status: 400 });
        });

        it('끝내는 중 장부 저장이 실패하면 finishedAt · pointsEarned · 잔액 · 장부가 함께 되돌아가고, 다시 끝내면 한 번만 지급된다', async () => {
            const me = await newUser();
            const attempt = await attemptWith(me, 3);
            // 풀이 finishedAt 변경과 잔액 증가가 끝난 다음, 장부 저장에서 한 번 실패시킨다
            const ledgerModel = conn.model(PointLedger.name);
            const spy = vi.spyOn(ledgerModel, 'create').mockRejectedValueOnce(new Error('장부 저장 실패'));

            await expect(service.finish(me.toString(), attempt.id)).rejects.toThrow('장부 저장 실패');
            expect(spy).toHaveBeenCalledTimes(1);

            const rolledBack = await rowOf(attempt.id);
            expect(rolledBack.finishedAt).toBeNull();
            expect(rolledBack.pointsEarned).toBe(0);
            expect(await balanceOf(me)).toBe(100);
            expect(await col('point_ledgers').countDocuments({ userId: me })).toBe(0);

            spy.mockRestore();

            expect(await service.finish(me.toString(), attempt.id)).toEqual({ pointsEarned: 12, balance: 112 });
            const done = await rowOf(attempt.id);
            expect(done.finishedAt).toBeInstanceOf(Date);
            expect(done.pointsEarned).toBe(12);
            expect(await balanceOf(me)).toBe(112);
            expect(await ledgerOf(me)).toHaveLength(1);

            expect(await service.finish(me.toString(), attempt.id)).toEqual({ pointsEarned: 0, balance: 112 });
            expect(await balanceOf(me)).toBe(112);
            expect(await ledgerOf(me)).toHaveLength(1);
        });
    });
});
