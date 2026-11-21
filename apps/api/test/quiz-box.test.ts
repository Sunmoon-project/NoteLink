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
import type { Material } from '../src/modules/content/schemas/material.schema.js';
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

    // #601 보관함을 노트(학습 폴더)별로 본다. folderId가 없으면 옛 앱처럼 전체
    it('GET에 folderId를 주면 서비스에 그대로 넘기고, 없으면 전체(undefined)를 묻는다', async () => {
        fake.box.mockClear();
        expect((await http().get('/api/v1/quiz-box').query({ folderId: ID }).set(AUTH)).status).toBe(200);
        expect(fake.box).toHaveBeenLastCalledWith(ME.toString(), ID);
        expect((await http().get('/api/v1/quiz-box').set(AUTH)).status).toBe(200);
        expect(fake.box).toHaveBeenLastCalledWith(ME.toString(), undefined);
    });

    it('folderId가 여러 개이거나 너무 길면 400', async () => {
        fake.box.mockClear();
        expect((await http().get(`/api/v1/quiz-box?folderId=${ID}&folderId=${ID}`).set(AUTH)).status).toBe(400);
        expect((await http().get('/api/v1/quiz-box').query({ folderId: 'a'.repeat(101) }).set(AUTH)).status).toBe(400);
        expect(fake.box).not.toHaveBeenCalled();
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
    const materialsModel = { find: vi.fn() };
    const countersModel = { findOneAndUpdate: vi.fn() };
    const connection = { transaction: (fn: (tx: object) => Promise<unknown>) => fn({}) };
    const svc = () =>
        new QuizBoxService(
            itemsModel as unknown as Model<QuizBoxItem>,
            countersModel as unknown as Model<QuizBoxCounter>,
            setsModel as unknown as Model<QuizSet>,
            connection as unknown as Connection,
            materialsModel as unknown as Model<Material>,
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
    const mineBSetId = new Types.ObjectId();
    const looseSetId = new Types.ObjectId();
    const legacySetId = new Types.ObjectId();
    const legacyMaterial = new Types.ObjectId();
    const deletedSetId = new Types.ObjectId();
    const deletedMaterial = new Types.ObjectId();
    // 폴더(#601): 내 세트는 폴더 A · B, 폴더 정보가 없는 옛 세트 하나, 남의 세트는 남의 폴더
    const FOLDER_A = new Types.ObjectId();
    const FOLDER_B = new Types.ObjectId();
    const OTHER_FOLDER = new Types.ObjectId();
    const mine = [q(1, { choices: ['가', '나'], conceptTags: ['개념'], difficulty: '상' }), q(2), q(3), q(4)];
    const mineB = [q(1)];
    const loose = [q(1)];
    const legacy = [q(1)]; // 폴더 없이 노트(materialId)만 적힌 옛 세트 — 노트는 폴더 A에 있다
    const ofDeletedNote = [q(1)]; // 폴더 없이 노트만 적힌 옛 세트 — 노트는 폴더 A에 있었고 지워졌다
    const theirs = [q(1)];
    const OTHER_USER = new Types.ObjectId();
    const sid = (x: { _id: Types.ObjectId }) => x._id.toString();

    let rows: Row[];
    /** 지운 세트 id(학습 폴더 삭제 등, #602) */
    let goneSets: Set<string>;
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
        deleteMany: vi.fn((filter: { userId: Types.ObjectId; questionId: { $in: Types.ObjectId[] }; quizSetId: { $in: Types.ObjectId[] } }) => {
            rows = rows.filter(
                (r) =>
                    !(same(r.userId, filter.userId) &&
                        filter.questionId.$in.some((i) => same(i, r.questionId)) &&
                        filter.quizSetId.$in.some((i) => same(i, r.quizSetId))),
            );
            return Promise.resolve({});
        }),
    };
    const countersModel = {
        findOneAndUpdate: vi.fn((filter: { _id: Types.ObjectId }, update: { $inc: { seq: number } }, _options?: { session?: unknown }) => {
            const next = (seqs.get(String(filter._id)) ?? 0) + update.$inc.seq;
            seqs.set(String(filter._id), next);
            return { lean: () => Promise.resolve({ _id: filter._id, seq: next }) };
        }),
    };
    const setFinds: { filter: { _id?: { $in: Types.ObjectId[] } }; projection?: object }[] = []; // 세트 조회 기록
    // 노트(자료): 옛 세트의 노트는 내 폴더 A, 지운 노트도 폴더 A, 남의 노트도 하나. 조건에 deletedAt이 있으면 Mongo처럼 거른다
    const materialsModel = {
        find: vi.fn((filter: { _id: { $in: Types.ObjectId[] }; ownerId: Types.ObjectId; folderId: Types.ObjectId; deletedAt?: null }) => ({
            lean: () =>
                Promise.resolve(
                    [
                        { _id: legacyMaterial, ownerId: ME, folderId: FOLDER_A, deletedAt: null },
                        { _id: deletedMaterial, ownerId: ME, folderId: FOLDER_A, deletedAt: new Date() },
                        { _id: new Types.ObjectId(), ownerId: OTHER_USER, folderId: OTHER_FOLDER, deletedAt: null },
                    ].filter(
                        (m) =>
                            filter._id.$in.some((i) => same(i, m._id)) &&
                            same(m.ownerId, filter.ownerId) &&
                            same(m.folderId, filter.folderId) &&
                            (!('deletedAt' in filter) || m.deletedAt === null),
                    ),
                ),
        })),
    };
    const setsModel = {
        find: (filter: { _id?: { $in: Types.ObjectId[] }; ownerId: Types.ObjectId; deletedAt?: null | { $ne: null }; 'questions._id'?: { $in: Types.ObjectId[] } }, projection?: object) => {
            setFinds.push({ filter, projection });
            const all = [
                { _id: mineSetId, ownerId: ME, folderId: FOLDER_A, questions: mine },
                { _id: mineBSetId, ownerId: ME, folderId: FOLDER_B, questions: mineB },
                { _id: looseSetId, ownerId: ME, questions: loose },
                { _id: legacySetId, ownerId: ME, materialId: legacyMaterial, questions: legacy },
                { _id: deletedSetId, ownerId: ME, materialId: deletedMaterial, questions: ofDeletedNote },
                { _id: otherSetId, ownerId: OTHER_USER, folderId: OTHER_FOLDER, questions: theirs },
            ]
                .map((st) => ({ ...st, deletedAt: goneSets.has(String(st._id)) ? new Date() : null }))
                .filter((st) => same(st.ownerId, filter.ownerId))
                // 지우지 않은 세트만(null) · 지운 세트만({ $ne: null }) 조건
                .filter((st) => !('deletedAt' in filter) || (filter.deletedAt === null ? st.deletedAt === null : st.deletedAt !== null));
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
            materialsModel as unknown as Model<Material>,
        );
    const idsOf = (list: { _id: string }[]) => list.map((x) => x._id);

    beforeEach(() => {
        rows = [];
        goneSets = new Set();
        seqs = new Map();
        itemsModel.bulkWrite.mockClear();
        countersModel.findOneAndUpdate.mockClear();
        lock = Promise.resolve();
        sessions.length = 0;
        findCalls.length = 0;
    });

    it('확인한 뒤 담기 전에 세트가 지워지면(학습 폴더 삭제, #602) 이 요청이 새로 담은 항목만 뺀다(Codex 1차)', async () => {
        await svc().save(ME.toString(), [sid(mine[0]!)]);
        // 세트를 확인한 뒤 담는 사이 폴더 삭제와 그 정리가 끝난다
        itemsModel.bulkWrite.mockImplementationOnce((ops) => {
            goneSets.add(String(mineSetId));
            for (const { updateOne } of ops) rows.push({ ...updateOne.update.$setOnInsert });
            return Promise.resolve({});
        });

        await svc().save(ME.toString(), [sid(mine[1]!), sid(mine[0]!)]);

        // 새로 담은 문제는 빠지고, 전에 담아 둔 문제는 그대로(보관함은 지운 세트의 문제도 보여 줌)
        expect(rows.map((r) => String(r.questionId))).toEqual([sid(mine[0]!)]);
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

    it('목록에 폴더를 주면 그 폴더 세트의 문제만 담은 순서로, 안 주면 지금처럼 전체를 돌려준다(#601)', async () => {
        await svc().save(ME.toString(), [sid(mineB[0]!), sid(loose[0]!), sid(mine[1]!), sid(mine[0]!)]);
        expect(idsOf(await svc().box(ME.toString()))).toEqual([sid(mineB[0]!), sid(loose[0]!), sid(mine[1]!), sid(mine[0]!)]);
        expect(idsOf(await svc().box(ME.toString(), FOLDER_A.toString()))).toEqual([sid(mine[1]!), sid(mine[0]!)]);
        expect(idsOf(await svc().box(ME.toString(), FOLDER_B.toString().toUpperCase()))).toEqual([sid(mineB[0]!)]);
        // 폴더 정보가 없는 세트의 문제는 어느 폴더에도 나오지 않는다
        expect(idsOf(await svc().box(ME.toString(), new Types.ObjectId().toString()))).toEqual([]);
    });

    it('폴더 없이 노트만 적힌 옛 세트의 문제는 그 노트의 폴더에 나온다(플래시 카드처럼, 지운 노트도)', async () => {
        await svc().save(ME.toString(), [sid(legacy[0]!), sid(mine[0]!), sid(ofDeletedNote[0]!), sid(mineB[0]!)]);
        expect(idsOf(await svc().box(ME.toString(), FOLDER_A.toString()))).toEqual([sid(legacy[0]!), sid(mine[0]!), sid(ofDeletedNote[0]!)]);
        expect(idsOf(await svc().box(ME.toString(), FOLDER_B.toString()))).toEqual([sid(mineB[0]!)]);
        // 노트는 폴더 없는 세트의 노트만, 내 것 중에서 읽는다
        const filter = materialsModel.find.mock.calls.at(-1)![0];
        expect(filter._id.$in.map(String).sort()).toEqual([legacyMaterial, deletedMaterial].map(String).sort());
        expect(filter.ownerId).toEqual(ME);
    });

    it('폴더로 열면 세트의 폴더 · 노트만 먼저 읽고, 문제는 그 폴더 세트만 읽는다', async () => {
        await svc().save(ME.toString(), [sid(mine[0]!), sid(mineB[0]!), sid(loose[0]!), sid(legacy[0]!)]);
        setFinds.length = 0;
        expect(idsOf(await svc().box(ME.toString(), FOLDER_B.toString()))).toEqual([sid(mineB[0]!)]);
        expect(setFinds).toHaveLength(2);
        expect(setFinds[0]!.projection).toEqual({ folderId: 1, materialId: 1 });
        expect(setFinds[1]!.projection).toBeUndefined();
        expect(setFinds[1]!.filter._id!.$in.map(String)).toEqual([String(mineBSetId)]);
        // 그 폴더 세트가 없으면 문제를 읽지 않는다
        setFinds.length = 0;
        expect(await svc().box(ME.toString(), new Types.ObjectId().toString())).toEqual([]);
        expect(setFinds).toHaveLength(1);
    });

    it('보관한 세트에 폴더 없는 세트가 없으면 노트를 읽지 않는다', async () => {
        await svc().save(ME.toString(), [sid(mine[0]!), sid(mineB[0]!)]);
        materialsModel.find.mockClear();
        expect(idsOf(await svc().box(ME.toString(), FOLDER_A.toString()))).toEqual([sid(mine[0]!)]);
        expect(materialsModel.find).not.toHaveBeenCalled();
    });

    it('목록 폴더가 남의 폴더 · 형식이 틀린 id면 빈 목록이다', async () => {
        await svc().save(ME.toString(), [sid(mine[0]!)]);
        expect(await svc().box(ME.toString(), OTHER_FOLDER.toString())).toEqual([]);
        expect(await svc().box(ME.toString(), 'not-an-id')).toEqual([]);
    });

    it('목록 폴더가 빈 값이면 주지 않은 것처럼 전체다(앱 http-api · 기기 저장 모드와 같게)', async () => {
        await svc().save(ME.toString(), [sid(mineB[0]!), sid(mine[0]!)]);
        expect(idsOf(await svc().box(ME.toString(), ''))).toEqual([sid(mineB[0]!), sid(mine[0]!)]);
    });

    it('남의 세트 문제가 섞이면 아무것도 담지 않고 404이고 번호도 받지 않는다', async () => {
        await expect(svc().save(ME.toString(), [sid(mine[0]!), sid(theirs[0]!)])).rejects.toBeInstanceOf(NotFoundException);
        expect(rows).toEqual([]);
        expect(countersModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
});
