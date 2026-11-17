import type { INestApplication } from '@nestjs/common';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { QuizBoxController } from '../src/modules/quiz/quiz-box.controller.js';
import { QuizBoxService } from '../src/modules/quiz/quiz-box.service.js';
import { BOX_MAX_IDS } from '../src/modules/quiz/dto/quiz-box.dto.js';
import type { QuizBoxCounter } from '../src/modules/quiz/schemas/quiz-box-counter.schema.js';
import type { QuizBoxItem } from '../src/modules/quiz/schemas/quiz-box-item.schema.js';
import type { QuizSet } from '../src/modules/quiz/schemas/quiz-set.schema.js';

const ME = new Types.ObjectId();
const AUTH = { Authorization: 'Bearer token-me' };
const ID = new Types.ObjectId().toString();

describe('퀴즈 보관함 API 주소 · 입력 검증', () => {
    const fake = {
        box: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
    };
    let app: INestApplication;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            controllers: [QuizBoxController],
            providers: [
                { provide: QuizBoxService, useValue: fake },
                {
                    provide: TokenService,
                    useValue: {
                        verifyAccess: (t: string) =>
                            t === 'token-me'
                                ? Promise.resolve({ userId: ME.toString() })
                                : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                    },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
    });
    afterAll(async () => app.close());

    const http = () => request(app.getHttpServer());

    it('로그인 없이는 401', async () => {
        expect((await http().get('/api/v1/quiz-box')).status).toBe(401);
        expect((await http().post('/api/v1/quiz-box').send({ questionIds: [] })).status).toBe(401);
        expect((await http().post('/api/v1/quiz-box/delete').send({ questionIds: [] })).status).toBe(401);
    });

    it('앱이 부르는 3개: GET 200, POST 담기 200, POST /delete 204', async () => {
        expect((await http().get('/api/v1/quiz-box').set(AUTH)).status).toBe(200);
        expect((await http().post('/api/v1/quiz-box').set(AUTH).send({ questionIds: [ID] })).status).toBe(200);
        expect(fake.save).toHaveBeenCalledWith(ME.toString(), [ID]);
        expect((await http().post('/api/v1/quiz-box/delete').set(AUTH).send({ questionIds: [ID] })).status).toBe(204);
        expect(fake.remove).toHaveBeenCalledWith(ME.toString(), [ID]);
    });

    it('questionIds가 배열의 문자열이 아니거나 너무 많거나 모르는 필드가 있으면 400', async () => {
        for (const body of [{}, { questionIds: 'a' }, { questionIds: [1] }, { questionIds: ['a'.repeat(101)] }, { questionIds: Array(BOX_MAX_IDS + 1).fill(ID) }, { questionIds: [], x: 1 }]) {
            expect((await http().post('/api/v1/quiz-box').set(AUTH).send(body)).status).toBe(400);
            expect((await http().post('/api/v1/quiz-box/delete').set(AUTH).send(body)).status).toBe(400);
        }
    });
});

describe('QuizBoxService (가짜 모델)', () => {
    const itemsModel = { find: vi.fn(), bulkWrite: vi.fn(), deleteMany: vi.fn() };
    const setsModel = { find: vi.fn() };
    const countersModel = { findOneAndUpdate: vi.fn() };
    const connection = { transaction: (fn: (tx: object) => Promise<unknown>) => fn({}) };
    const svc = () =>
        new QuizBoxService(
            itemsModel as unknown as Model<QuizBoxItem>,
            countersModel as unknown as Model<QuizBoxCounter>,
            setsModel as unknown as Model<QuizSet>,
            connection as unknown as Connection,
        );

    it('담기: 형식이 틀린 id가 있으면 DB를 거치지 않고 404', async () => {
        await expect(svc().save(ME.toString(), [ID, 'not-an-id'])).rejects.toBeInstanceOf(NotFoundException);
        expect(setsModel.find).not.toHaveBeenCalled();
        expect(itemsModel.bulkWrite).not.toHaveBeenCalled();
        expect(countersModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('담기: 내 세트에서 못 찾는 문제가 있으면 하나도 담지 않고 404', async () => {
        setsModel.find.mockReturnValue({ lean: () => Promise.resolve([]) });
        await expect(svc().save(ME.toString(), [ID])).rejects.toBeInstanceOf(NotFoundException);
        expect(itemsModel.bulkWrite).not.toHaveBeenCalled();
        expect(countersModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('담기: 빈 목록은 아무것도 하지 않고 보관함만 돌려준다', async () => {
        setsModel.find.mockClear();
        itemsModel.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([]) }) });
        await expect(svc().save(ME.toString(), [])).resolves.toEqual([]);
        expect(setsModel.find).not.toHaveBeenCalled();
    });

    it('삭제: 형식이 틀린 id만 있으면 DB를 거치지 않고, 아니면 내 보관함에서만 지운다', async () => {
        await svc().remove(ME.toString(), ['not-an-id']);
        expect(itemsModel.deleteMany).not.toHaveBeenCalled();
        await svc().remove(ME.toString(), [ID, ID.toUpperCase(), 'bad']);
        expect(itemsModel.deleteMany).toHaveBeenCalledTimes(1);
        const [filter] = itemsModel.deleteMany.mock.calls[0]!;
        expect(filter.userId).toEqual(ME);
        expect(filter.questionId.$in).toHaveLength(1); // 대소문자만 다른 id는 하나로
    });
});

// ---- 담기 · 목록 · 중복 · 순서 (메모리에 두는 가짜 모델: 실제 DB 없이 기본 CI에서 확인한다) ----
describe('QuizBoxService 담기 · 목록 · 순서 (메모리 가짜 모델)', () => {
    type Row = { userId: Types.ObjectId; questionId: Types.ObjectId; quizSetId: Types.ObjectId; savedAt: Date; order?: number };
    const q = (order: number, extra: object = {}) => ({
        _id: new Types.ObjectId(), order, prompt: `문제 ${order}`, answer: `정답 ${order}`, explanation: null, conceptTags: [], choices: null, difficulty: null, ...extra,
    });
    const mineSetId = new Types.ObjectId();
    const otherSetId = new Types.ObjectId();
    const mine = [q(1, { choices: ['가', '나'], conceptTags: ['개념'], difficulty: '상' }), q(2), q(3), q(4)];
    const theirs = [q(1)];
    const OTHER_USER = new Types.ObjectId();
    const sid = (x: { _id: Types.ObjectId }) => x._id.toString();

    let rows: Row[];
    const findCalls: { filter: { questionId?: unknown }; options?: { session?: unknown } }[] = [];
    let seqs: Map<string, number>;
    const same = (a: unknown, b: unknown) => String(a) === String(b);

    // Mongo처럼 값이 없으면 숫자보다 앞에 정렬한다
    const cmp = (a: unknown, b: unknown) => {
        const av = a ?? -Infinity;
        const bv = b ?? -Infinity;
        const [x, y] = av instanceof Date || bv instanceof Date ? [new Date(av as Date).getTime(), new Date(bv as Date).getTime()] : [av, bv];
        return (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
    };
    const itemsModel = {
        find: (filter: { userId: Types.ObjectId; questionId?: { $in: Types.ObjectId[] } }, ...rest: unknown[]) => {
            findCalls.push({ filter, options: rest[1] as { session?: unknown } | undefined });
            const hit = rows.filter((r) => same(r.userId, filter.userId) && (!filter.questionId || filter.questionId.$in.some((i) => same(i, r.questionId))));
            return {
                lean: () => Promise.resolve(hit),
                sort: (spec: Record<string, 1 | -1>) => ({
                    lean: () =>
                        Promise.resolve(
                            [...hit].sort((a, b) => {
                                for (const [key, dir] of Object.entries(spec)) {
                                    const c = cmp((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
                                    if (c !== 0) return c * dir;
                                }
                                return 0;
                            }),
                        ),
                }),
            };
        },
        bulkWrite: vi.fn((ops: { updateOne: { filter: { userId: Types.ObjectId; questionId: Types.ObjectId }; update: { $setOnInsert: Row } } }[], _options?: { session?: unknown }) => {
            for (const { updateOne } of ops) {
                const { filter, update } = updateOne;
                if (!rows.some((r) => same(r.userId, filter.userId) && same(r.questionId, filter.questionId))) rows.push({ ...update.$setOnInsert });
            }
            return Promise.resolve({});
        }),
        deleteMany: vi.fn(),
    };
    const countersModel = {
        findOneAndUpdate: vi.fn((filter: { _id: Types.ObjectId }, update: { $inc: { seq: number } }, _options?: { session?: unknown }) => {
            const next = (seqs.get(String(filter._id)) ?? 0) + update.$inc.seq;
            seqs.set(String(filter._id), next);
            return { lean: () => Promise.resolve({ _id: filter._id, seq: next }) };
        }),
    };
    const setsModel = {
        find: (filter: { _id?: { $in: Types.ObjectId[] }; ownerId: Types.ObjectId; 'questions._id'?: { $in: Types.ObjectId[] } }) => {
            const all = [
                { _id: mineSetId, ownerId: ME, deletedAt: null, questions: mine },
                { _id: otherSetId, ownerId: OTHER_USER, deletedAt: null, questions: theirs },
            ].filter((st) => same(st.ownerId, filter.ownerId));
            const hit = filter._id
                ? all.filter((st) => filter._id!.$in.some((i) => same(i, st._id)))
                : all.filter((st) => st.questions.some((qq) => filter['questions._id']!.$in.some((i) => same(i, qq._id))));
            return { lean: () => Promise.resolve(hit) };
        },
    };
    // 트랜잭션 흉내: 같은 사람의 카운터를 함께 쓰는 겹치는 요청은 실제 DB에서 쓰기 충돌로 하나씩 다시 시도되므로,
    // 여기서는 요청을 한 줄로 세워 하나가 끝난 뒤 다음이 처음부터(기존 항목 확인부터) 실행되게 한다
    let lock: Promise<unknown> = Promise.resolve();
    const sessions: object[] = []; // transaction()이 콜백에 넘긴 세션들
    const connection = {
        transaction: (fn: (tx: object) => Promise<unknown>) => {
            const run = lock.then(() => {
                const tx = {};
                sessions.push(tx);
                return fn(tx);
            });
            lock = run.catch(() => undefined);
            return run;
        },
    };
    const svc = () =>
        new QuizBoxService(
            itemsModel as unknown as Model<QuizBoxItem>,
            countersModel as unknown as Model<QuizBoxCounter>,
            setsModel as unknown as Model<QuizSet>,
            connection as unknown as Connection,
        );
    const idsOf = (list: { _id: string }[]) => list.map((x) => x._id);

    beforeEach(() => {
        rows = [];
        seqs = new Map();
        itemsModel.bulkWrite.mockClear();
        countersModel.findOneAndUpdate.mockClear();
        lock = Promise.resolve();
        sessions.length = 0;
        findCalls.length = 0;
    });

    it('담으면 보낸 순서대로 이어진 번호가 붙고, 목록은 앱 모양(정답 포함)으로 번호 순으로 나온다', async () => {
        const list = await svc().save(ME.toString(), [sid(mine[2]!), sid(mine[0]!)]);
        expect(idsOf(list)).toEqual([sid(mine[2]!), sid(mine[0]!)]); // 문제 번호 순이 아니라 보낸 순서
        expect(list[1]).toEqual({
            _id: sid(mine[0]!), order: 1, type: 'multiple_choice', prompt: '문제 1', choices: ['가', '나'],
            answer: '정답 1', explanation: null, conceptTags: ['개념'], difficulty: '상',
        });
        expect(list[0]).toMatchObject({ type: 'short_answer', answer: '정답 3', choices: null });
        expect(rows.map((r) => r.order)).toEqual([1, 2]);
        expect(rows.every((r) => r.savedAt instanceof Date)).toBe(true);
        // 번호는 한 번에 받는다(요청당 카운터 한 번, 저장도 한 번)
        expect(countersModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(countersModel.findOneAndUpdate.mock.calls[0]![1]).toEqual({ $inc: { seq: 2 } });
        expect(itemsModel.bulkWrite).toHaveBeenCalledTimes(1);
    });

    it('나중에 담은 문제는 뒤에 붙는다 (이어서 번호를 받는다)', async () => {
        await svc().save(ME.toString(), [sid(mine[2]!), sid(mine[0]!)]);
        const list = await svc().save(ME.toString(), [sid(mine[1]!)]);
        expect(idsOf(list)).toEqual([sid(mine[2]!), sid(mine[0]!), sid(mine[1]!)]);
        expect(rows.map((r) => r.order)).toEqual([1, 2, 3]);
    });

    it('이미 담긴 문제를 다시 담아도 번호 · 담은 시각 · 순서가 바뀌지 않고, 번호는 새 문제 개수만큼만 받는다', async () => {
        const [a, b, c] = [sid(mine[0]!), sid(mine[1]!), sid(mine[2]!)];
        await svc().save(ME.toString(), [a, b]);
        const before = rows.map((r) => ({ ...r }));
        countersModel.findOneAndUpdate.mockClear();
        itemsModel.bulkWrite.mockClear();

        expect(idsOf(await svc().save(ME.toString(), [b, a]))).toEqual([a, b]); // 보낸 순서가 달라도 그대로
        expect(countersModel.findOneAndUpdate).not.toHaveBeenCalled(); // 새 문제가 없으면 번호를 받지 않는다
        expect(itemsModel.bulkWrite).not.toHaveBeenCalled();

        const list = await svc().save(ME.toString(), [a, c, a.toUpperCase()]); // 일부만 새 문제 · 요청 안 중복
        expect(idsOf(list)).toEqual([a, b, c]);
        expect(countersModel.findOneAndUpdate.mock.calls[0]![1]).toEqual({ $inc: { seq: 1 } });
        expect(itemsModel.bulkWrite.mock.calls[0]![0]).toHaveLength(1);
        expect(rows.slice(0, 2)).toEqual(before);
        expect(rows[2]!.order).toBe(3);
    });

    it('번호는 사람마다 따로 센다 (다른 사람 보관함이 섞이지 않는다)', async () => {
        const other = new Types.ObjectId();
        rows.push({ userId: other, questionId: mine[0]!._id, quizSetId: mineSetId, savedAt: new Date(), order: 7 });
        seqs.set(other.toString(), 7);
        const list = await svc().save(ME.toString(), [sid(mine[0]!)]);
        expect(idsOf(list)).toEqual([sid(mine[0]!)]);
        expect(rows.find((r) => r.userId.equals(ME))!.order).toBe(1);
    });

    it('번호가 없는 옛 문서는 savedAt 순으로 맨 앞에 오고, 새로 담은 문제가 그 뒤에 붙는다', async () => {
        const old = (qq: { _id: Types.ObjectId }, ms: number): Row => ({ userId: ME, questionId: qq._id, quizSetId: mineSetId, savedAt: new Date(ms) });
        rows.push(old(mine[1]!, 2000), old(mine[0]!, 1000)); // order 없음, 저장된 순서와 savedAt 순이 다르다
        const list = await svc().save(ME.toString(), [sid(mine[3]!)]);
        expect(idsOf(list)).toEqual([sid(mine[0]!), sid(mine[1]!), sid(mine[3]!)]);
        expect(rows.find((r) => r.questionId.equals(mine[3]!._id))!.order).toBe(1); // 옛 문서 뒤에는 번호로 정렬된다
    });

    it('겹치는 동시 저장: 앞 요청이 [a,b,c], 뒤 요청이 [b,d]이고 뒤 요청의 삽입이 먼저 끝나려 해도 순서는 [a,b,c,d]다', async () => {
        const [a, b, c, d] = [sid(mine[0]!), sid(mine[1]!), sid(mine[2]!), sid(mine[3]!)];
        // 3개를 담는 첫 요청의 삽입만 늦춰서, 보호가 없으면 두 번째 요청의 삽입이 먼저 끝나게 한다
        const realBulk = itemsModel.bulkWrite.getMockImplementation()!;
        itemsModel.bulkWrite.mockImplementation(async (ops) => {
            if (ops.length === 3) await new Promise((resolve) => setTimeout(resolve, 20));
            return realBulk(ops);
        });
        try {
            await Promise.all([svc().save(ME.toString(), [a, b, c]), svc().save(ME.toString(), [b, d])]);
        } finally {
            itemsModel.bulkWrite.mockImplementation(realBulk);
        }
        const list = await svc().save(ME.toString(), []);
        expect(idsOf(list)).toEqual([a, b, c, d]);
        expect(rows.map((r) => r.order)).toEqual([1, 2, 3, 4]); // 번호도 건너뛰지 않는다
    });

    it('저장의 모든 DB 호출(기존 항목 조회 · 카운터 갱신 · 일괄 삽입)이 트랜잭션이 넘긴 같은 세션을 쓴다', async () => {
        await svc().save(ME.toString(), [sid(mine[0]!), sid(mine[1]!)]);
        expect(sessions).toHaveLength(1);
        const [tx] = sessions;
        // 기존 항목 조회는 questionId로 찾는 find (뒤의 목록 조회 box()는 트랜잭션 밖이다)
        const existingCall = findCalls.find((c) => c.filter.questionId);
        expect(existingCall?.options?.session).toBe(tx);
        expect(countersModel.findOneAndUpdate.mock.calls[0]![2]?.session).toBe(tx);
        expect(itemsModel.bulkWrite.mock.calls[0]![1]?.session).toBe(tx);
    });

    it('삽입이 실패하면 오류를 그대로 던진다', async () => {
        itemsModel.bulkWrite.mockImplementationOnce(() => Promise.reject(new Error('db down')));
        await expect(svc().save(ME.toString(), [sid(mine[0]!)])).rejects.toThrow('db down');
    });

    it('남의 세트 문제가 섞이면 아무것도 담지 않고 404이고 번호도 받지 않는다', async () => {
        await expect(svc().save(ME.toString(), [sid(mine[0]!), sid(theirs[0]!)])).rejects.toBeInstanceOf(NotFoundException);
        expect(rows).toEqual([]);
        expect(countersModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
});
