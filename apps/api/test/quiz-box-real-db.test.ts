// 진짜 MongoDB에서 퀴즈 보관함 API(FR-57 · 58)를 확인하는 테스트.
// 확인하는 것: 담기 · 목록(담은 순서, 정답 포함) · 삭제, 같은 문제를 두 번 · 동시에 담아도 한 건, 남의 세트 문제 · 없는 문제 · 잘못된 id → 404(하나라도 틀리면 아무것도 안 담김),
// 다른 사람 보관함이 섞이지 않음, 남의 보관함 항목은 지워지지 않음, 인덱스,
// 담은 순서 번호(사용자별 카운터): 동시에 담아도 요청별로 이어진 번호 · 번호가 겹치지 않음 · 다시 담아도 순서 그대로, 겹치는 요청([a,b,c]와 [b,d])도 순서 유지, 한 번에 3000개까지(실제 HTTP).
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/quiz-box-real-db.test.ts
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { BOX_MAX_IDS } from '../src/modules/quiz/dto/quiz-box.dto.js';
import { QuizBoxController } from '../src/modules/quiz/quiz-box.controller.js';
import { QuizBoxService } from '../src/modules/quiz/quiz-box.service.js';
import { QuizBoxCounter, QuizBoxCounterSchema } from '../src/modules/quiz/schemas/quiz-box-counter.schema.js';
import { QuizBoxItem, QuizBoxItemSchema } from '../src/modules/quiz/schemas/quiz-box-item.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_quiz_box_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 퀴즈 보관함 확인', () => {
    const me = new Types.ObjectId();
    const other = new Types.ObjectId();
    const tokens: Record<string, Types.ObjectId> = { 'token-me': me, 'token-other': other };
    const AUTH = { Authorization: 'Bearer token-me' };
    const AUTH_OTHER = { Authorization: 'Bearer token-other' };
    let app: INestApplication;
    let conn: Connection;
    const col = (name: string) => conn.collection(name);

    const http = () => request(app.getHttpServer());
    const box = (auth = AUTH) => http().get('/api/v1/quiz-box').set(auth);
    const save = (questionIds: string[], auth = AUTH) => http().post('/api/v1/quiz-box').set(auth).send({ questionIds });
    const remove = (questionIds: string[], auth = AUTH) => http().post('/api/v1/quiz-box/delete').set(auth).send({ questionIds });
    const idsOf = (res: request.Response) => (res.body.data as { _id: string }[]).map((q) => q._id);

    // 내 세트(문제 3개), 내 지운 세트(1개), 남의 세트(2개)
    const q = (order: number, extra: object = {}) => ({
        _id: new Types.ObjectId(), order, prompt: `문제 ${order}`, answer: `정답 ${order}`, explanation: null, conceptTags: [], choices: null, difficulty: null, ...extra,
    });
    const mineQs = [q(1, { choices: ['가', '나'], conceptTags: ['개념'], difficulty: '상' }), q(2), q(3, { passage: '지문입니다' })];
    const deletedQs = [q(1)];
    const otherQs = [q(1), q(2)];
    const mineSet = new Types.ObjectId();
    const deletedSet = new Types.ObjectId();
    const otherSet = new Types.ObjectId();
    const sid = (x: { _id: Types.ObjectId }) => x._id.toString();

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: QuizBoxItem.name, schema: QuizBoxItemSchema },
                    { name: QuizBoxCounter.name, schema: QuizBoxCounterSchema },
                    { name: QuizSet.name, schema: QuizSetSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [QuizBoxController],
            providers: [
                QuizBoxService,
                {
                    provide: TokenService,
                    useValue: {
                        verifyAccess: (t: string) =>
                            tokens[t]
                                ? Promise.resolve({ userId: tokens[t].toString() })
                                : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                    },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        await Promise.all([conn.model(QuizBoxItem.name).init(), conn.model(QuizBoxCounter.name).init(), conn.model(QuizSet.name).init(), conn.model(User.name).init()]);
        // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
        await col('users').insertMany([
            { _id: me, nickname: `me_${process.pid}`, email: `me_${process.pid}@example.com` },
            { _id: other, nickname: `other_${process.pid}`, email: `other_${process.pid}@example.com` },
        ]);
        const base = { source: 'ai_generated', status: 'ready', progress: 100, deletedAt: null };
        await col('quiz_sets').insertMany([
            { _id: mineSet, ownerId: me, title: '내 세트', questions: mineQs, questionCount: 3, ...base },
            { _id: deletedSet, ownerId: me, title: '지운 세트', questions: deletedQs, questionCount: 1, ...base, deletedAt: new Date() },
            { _id: otherSet, ownerId: other, title: '남의 세트', questions: otherQs, questionCount: 2, ...base },
        ]);
    }, 30000);

    afterEach(async () => {
        await Promise.all([col('quiz_box_items').deleteMany({}), col('quiz_box_counters').deleteMany({})]);
    });

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    it('1) 담기 · 목록 · 삭제: 앱 모양의 문제(정답 포함)가 담은 순서로 나온다', async () => {
        expect(idsOf(await box())).toEqual([]);
        const saved = await save([sid(mineQs[2]!), sid(mineQs[0]!)]);
        expect(saved.status).toBe(200);
        expect(idsOf(saved)).toEqual([sid(mineQs[2]!), sid(mineQs[0]!)]); // 보낸 순서(문제 번호 순이 아니다)
        expect(saved.body.data[1]).toEqual({
            _id: sid(mineQs[0]!), order: 1, type: 'multiple_choice', prompt: '문제 1', choices: ['가', '나'],
            answer: '정답 1', explanation: null, conceptTags: ['개념'], difficulty: '상',
        });
        expect(saved.body.data[0]).toMatchObject({ type: 'short_answer', prompt: '문제 3\n\n지문입니다', answer: '정답 3', choices: null });

        // 나중에 담은 문제는 뒤에 붙는다
        expect(idsOf(await save([sid(mineQs[1]!)]))).toEqual([sid(mineQs[2]!), sid(mineQs[0]!), sid(mineQs[1]!)]);
        expect(idsOf(await box())).toEqual([sid(mineQs[2]!), sid(mineQs[0]!), sid(mineQs[1]!)]);

        expect((await remove([sid(mineQs[0]!)])).status).toBe(204);
        expect(idsOf(await box())).toEqual([sid(mineQs[2]!), sid(mineQs[1]!)]);
    });

    it('2) 같은 문제를 두 번 · 한 번에 중복해서 · 동시에 담아도 한 건이고 순서가 바뀌지 않는다', async () => {
        const [a, b] = [sid(mineQs[0]!), sid(mineQs[1]!)];
        await save([a, a, a.toUpperCase()]);
        await save([b]);
        await save([a]); // 이미 담긴 것을 다시 담아도 맨 뒤로 가지 않는다
        expect(idsOf(await box())).toEqual([a, b]);

        await col('quiz_box_items').deleteMany({});
        const results = await Promise.all([1, 2, 3, 4, 5].map(() => save([a, b])));
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect(await col('quiz_box_items').countDocuments({ userId: me })).toBe(2);
        expect(new Set(idsOf(await box()))).toEqual(new Set([a, b]));
    });

    it('3) 남의 세트 문제 · 지운 세트 문제 · 없는 문제 · 잘못된 id는 404이고, 하나라도 틀리면 아무것도 담기지 않는다', async () => {
        const mine = sid(mineQs[0]!);
        for (const bad of [sid(otherQs[0]!), sid(deletedQs[0]!), new Types.ObjectId().toString(), 'not-an-id', '']) {
            const res = await save([mine, bad]);
            expect(res.status).toBe(404);
            expect(res.body.code).toBe('NOT_FOUND');
        }
        expect(await col('quiz_box_items').countDocuments()).toBe(0);
        // 남의 문제가 그 사람에게는 담긴다
        expect((await save([sid(otherQs[0]!)], AUTH_OTHER)).status).toBe(200);
    });

    it('4) 입력이 이상하면 400이고, 빈 목록은 담지 않고 현재 보관함을 돌려준다', async () => {
        expect((await http().post('/api/v1/quiz-box').set(AUTH).send({})).status).toBe(400);
        expect((await http().post('/api/v1/quiz-box').set(AUTH).send({ questionIds: 'x' })).status).toBe(400);
        expect((await http().post('/api/v1/quiz-box/delete').set(AUTH).send({ questionIds: [1] })).status).toBe(400);
        await save([sid(mineQs[0]!)]);
        const empty = await save([]);
        expect(empty.status).toBe(200);
        expect(idsOf(empty)).toEqual([sid(mineQs[0]!)]);
    });

    it('5) 다른 사람 보관함이 섞이지 않는다', async () => {
        await save([sid(mineQs[0]!)]);
        await save([sid(otherQs[1]!)], AUTH_OTHER);
        expect(idsOf(await box())).toEqual([sid(mineQs[0]!)]);
        expect(idsOf(await box(AUTH_OTHER))).toEqual([sid(otherQs[1]!)]);
        expect((await http().get('/api/v1/quiz-box')).status).toBe(401);
    });

    it('6) 남의 보관함 항목은 지울 수 없다 (내 보관함에서 빼는 요청은 남의 것에 영향이 없다)', async () => {
        await save([sid(otherQs[0]!)], AUTH_OTHER);
        const res = await remove([sid(otherQs[0]!)]); // 내 보관함에는 없다 → 그냥 넘어간다
        expect(res.status).toBe(204);
        expect(idsOf(await box(AUTH_OTHER))).toEqual([sid(otherQs[0]!)]);
        // 보관함에 없는 문제 · 잘못된 id를 지우는 것도 앱처럼 오류 없이 넘어간다
        expect((await remove([new Types.ObjectId().toString(), 'not-an-id'])).status).toBe(204);
        expect(await col('quiz_box_items').countDocuments()).toBe(1);
    });

    it('7) 세트를 지워도(deletedAt) 이미 담은 문제는 보관함에 남고, 문제 자체가 없어지면 목록에서만 빠진다', async () => {
        const target = new Types.ObjectId();
        const tmpQ = q(1);
        await col('quiz_sets').insertOne({ _id: target, ownerId: me, title: '임시', source: 'ai_generated', status: 'ready', progress: 100, questions: [tmpQ], questionCount: 1, deletedAt: null });
        await save([sid(tmpQ)]);
        await col('quiz_sets').updateOne({ _id: target }, { $set: { deletedAt: new Date() } });
        expect(idsOf(await box())).toEqual([sid(tmpQ)]);
        await col('quiz_sets').updateOne({ _id: target }, { $set: { questions: [] } });
        expect(idsOf(await box())).toEqual([]);
        await col('quiz_sets').deleteOne({ _id: target });
    });

    it('8) 인덱스: 같은 사람 + 문제는 유일하고, 다른 사람은 같은 문제를 따로 담을 수 있다', async () => {
        const doc = { userId: me, questionId: mineQs[0]!._id, quizSetId: mineSet, savedAt: new Date() };
        await col('quiz_box_items').insertOne({ ...doc });
        await expect(col('quiz_box_items').insertOne({ ...doc })).rejects.toThrow(/duplicate key/);
        await expect(col('quiz_box_items').insertOne({ ...doc, userId: other })).resolves.toBeTruthy();
    });

    it('9) 순서: 두 요청을 동시에 보내도 각 요청의 문제가 서로 섞이지 않고 번호가 겹치지 않는다', async () => {
        const setId = new Types.ObjectId();
        const qs = Array.from({ length: 60 }, (_, i) => q(i + 1));
        await col('quiz_sets').insertOne({ _id: setId, ownerId: me, title: '큰 세트', questions: qs, questionCount: 60, source: 'ai_generated', status: 'ready', progress: 100, deletedAt: null });
        for (let round = 0; round < 5; round++) {
            await Promise.all([col('quiz_box_items').deleteMany({}), col('quiz_box_counters').deleteMany({})]);
            const a = qs.slice(0, 30).map(sid);
            const b = qs.slice(30).map(sid).reverse(); // 보낸 순서 그대로 담긴다
            const [ra, rb] = await Promise.all([save(a), save(b)]);
            expect([ra.status, rb.status]).toEqual([200, 200]);

            const listed = idsOf(await box());
            expect(listed).toHaveLength(60);
            const posA = a.map((id) => listed.indexOf(id));
            const posB = b.map((id) => listed.indexOf(id));
            const contiguous = (pos: number[]) => pos.every((p, i) => i === 0 || p === pos[i - 1]! + 1); // 보낸 순서대로 이어져 있다
            expect(contiguous(posA)).toBe(true);
            expect(contiguous(posB)).toBe(true);

            const orders = (await col('quiz_box_items').find({ userId: me }).toArray()).map((r) => r['order'] as number);
            expect(new Set(orders).size).toBe(60); // 번호가 겹치지 않는다
            expect([...orders].sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
        }
        await col('quiz_sets').deleteOne({ _id: setId });
    });

    it('9-2) 순서: 문제가 겹치는 두 요청([a,b,c]와 [b,d])을 동시에 여러 번 보내도 공유 문제가 뒤로 밀리지 않는다', async () => {
        // 겹치는 요청은 쓰기 충돌로 하나씩 다시 시도되므로 가능한 결과는 둘뿐이다: 앞 요청이 먼저 [a,b,c,d], 뒤 요청이 먼저 [b,d,a,c].
        // 번호만 먼저 받고 삽입이 뒤바뀌면 [a,c,b,d]처럼 b가 4번으로 밀린다
        const setId = new Types.ObjectId();
        const qs = [q(1), q(2), q(3), q(4)];
        await col('quiz_sets').insertOne({ _id: setId, ownerId: me, title: '겹침 세트', questions: qs, questionCount: 4, source: 'ai_generated', status: 'ready', progress: 100, deletedAt: null });
        const [a, b, c, d] = qs.map(sid) as [string, string, string, string];
        const seen = new Set<string>();
        for (let round = 0; round < 30; round++) {
            await Promise.all([col('quiz_box_items').deleteMany({}), col('quiz_box_counters').deleteMany({})]);
            const [r1, r2] = await Promise.all([save([a, b, c]), save([b, d])]);
            expect([r1.status, r2.status]).toEqual([200, 200]);
            const listed = idsOf(await box());
            seen.add(listed.join());
            expect([[a, b, c, d].join(), [b, d, a, c].join()]).toContain(listed.join());
            const orders = (await col('quiz_box_items').find({ userId: me }).toArray()).map((r) => r['order'] as number);
            expect([...orders].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]); // 번호가 건너뛰지 않는다
        }
        expect(seen.size).toBeGreaterThan(0);
        await col('quiz_sets').deleteOne({ _id: setId });
    });

    it('10) 순서: 이미 담긴 문제를 다시 담아도 번호 · 순서가 바뀌지 않고, 번호는 새 문제만큼만 올라간다', async () => {
        const [a, b, c] = [sid(mineQs[0]!), sid(mineQs[1]!), sid(mineQs[2]!)];
        await save([b, a]);
        const before = await col('quiz_box_items').find({ userId: me }).sort({ order: 1 }).toArray();
        expect(before.map((r) => r['order'])).toEqual([1, 2]);

        await Promise.all([save([a, b]), save([b]), save([a, a])]); // 모두 이미 담긴 문제
        expect(idsOf(await save([a, c, b]))).toEqual([b, a, c]); // 일부만 새 문제
        const after = await col('quiz_box_items').find({ userId: me }).sort({ order: 1 }).toArray();
        expect(after.map((r) => [String(r['questionId']), r['order']])).toEqual([[b, 1], [a, 2], [c, 3]]);
        expect(after[0]!['savedAt']).toEqual(before[0]!['savedAt']); // 담은 시각도 그대로
        expect(await col('quiz_box_counters').findOne({ _id: me as never })).toMatchObject({ seq: 3 });
    });

    it('11) 순서: 번호가 없는 옛 문서는 savedAt 순으로 맨 앞에 오고, 새로 담은 문제는 그 뒤에 붙는다', async () => {
        const base = { userId: me, quizSetId: mineSet };
        await col('quiz_box_items').insertMany([
            { ...base, questionId: mineQs[1]!._id, savedAt: new Date('2026-01-02T00:00:00Z') },
            { ...base, questionId: mineQs[0]!._id, savedAt: new Date('2026-01-01T00:00:00Z') },
        ]);
        expect(idsOf(await box())).toEqual([sid(mineQs[0]!), sid(mineQs[1]!)]);
        expect(idsOf(await save([sid(mineQs[2]!)]))).toEqual([sid(mineQs[0]!), sid(mineQs[1]!), sid(mineQs[2]!)]);
    });

    it('12) 인덱스: QuizBoxService.box()의 실제 조회(userId + order · savedAt · _id 정렬)가 인덱스를 쓴다 (COLLSCAN이 아니다)', async () => {
        // 내 항목은 적게, 남의 항목은 많이 두어 userId로 좁히는 인덱스가 더 좋은 계획이 되게 한다
        const others = Array.from({ length: 200 }, (_, i) => ({ userId: new Types.ObjectId(), questionId: new Types.ObjectId(), quizSetId: mineSet, savedAt: new Date(), order: i + 1 }));
        await col('quiz_box_items').insertMany(others);
        await save([sid(mineQs[0]!), sid(mineQs[1]!)]);

        // box()가 DB에 실제로 보낸 find의 조건 · 정렬을 가로채서 그대로 explain에 넣는다 (테스트가 따로 만든 조회가 아니다)
        const sent: { filter: Record<string, unknown>; sort: Record<string, number> }[] = [];
        mongoose.set('debug', (collection: string, method: string, ...args: unknown[]) => {
            if (collection === 'quiz_box_items' && method === 'find') {
                sent.push({ filter: args[0] as Record<string, unknown>, sort: (args[1] as { sort: Record<string, number> }).sort });
            }
        });
        try {
            await app.get(QuizBoxService).box(me.toString());
        } finally {
            mongoose.set('debug', false);
        }
        expect(sent).toHaveLength(1);
        expect(sent[0]!.sort).toEqual({ order: 1, savedAt: 1, _id: 1 });

        const explained = await conn.db!.command({
            explain: { find: 'quiz_box_items', filter: sent[0]!.filter, sort: sent[0]!.sort },
            verbosity: 'queryPlanner',
        });
        const plan = JSON.stringify(explained['queryPlanner'].winningPlan);
        expect(plan).toMatch(/IXSCAN/);
        expect(plan).not.toMatch(/COLLSCAN/);
        // userId로 범위를 좁히는 인덱스를 쓴다 (정렬은 좁혀진 내 항목만 메모리에서 한다)
        expect(plan).toMatch(/"keyPattern":\{"userId":1/);
    });

    describe('한 번에 상한(3000개)까지', () => {
        const bigSet = new Types.ObjectId();
        const bigQs = Array.from({ length: BOX_MAX_IDS }, (_, i) => q(i + 1));

        beforeAll(async () => {
            await col('quiz_sets').insertOne({ _id: bigSet, ownerId: me, title: '3000문제', questions: bigQs, questionCount: bigQs.length, source: 'ai_generated', status: 'ready', progress: 100, deletedAt: null });
        });
        afterAll(async () => {
            await col('quiz_sets').deleteOne({ _id: bigSet });
        });

        it('13) 3000개를 한 번에 담고 지워도 되고(실제 HTTP), 3001개는 400이다. 지울 때 남의 보관함은 그대로', async () => {
            const ids = bigQs.map(sid);
            const saved = await save(ids);
            expect(saved.status).toBe(200);
            expect(idsOf(saved)).toEqual(ids); // 보낸 순서 그대로
            await col('quiz_box_items').insertOne({ userId: other, questionId: bigQs[0]!._id, quizSetId: bigSet, savedAt: new Date(), order: 1 });

            const tooMany = [...ids, new Types.ObjectId().toString()];
            expect((await save(tooMany)).status).toBe(400);
            expect((await remove(tooMany)).status).toBe(400);
            expect(await col('quiz_box_items').countDocuments({ userId: me })).toBe(BOX_MAX_IDS); // 400이면 아무것도 안 바뀐다

            expect((await remove(ids)).status).toBe(204);
            expect(await col('quiz_box_items').countDocuments({ userId: me })).toBe(0);
            expect(await col('quiz_box_items').countDocuments({ userId: other })).toBe(1);
        }, 60000);
    });
});
