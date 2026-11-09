import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH, createShopTestApp, TEST_USER_ID } from './shop-test-app.js';

// 로그인한 사람의 포인트 내역 한 건
const row = {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(TEST_USER_ID),
    amount: 30,
    balanceAfter: 130,
    reasonType: 'session_complete',
    description: null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
};

// 가짜 point_ledgers: find → sort → limit → lean 순서로 불리고, 넘어온 값을 기록해 둔다
let lastFilter: Record<string, unknown> = {};
let lastSort: Record<string, number> = {};
let lastLimit = 0;
const lean = vi.fn();
const pointLedgerModel = {
    find: vi.fn((filter: Record<string, unknown>) => {
        lastFilter = filter;
        return {
            sort: (spec: Record<string, number>) => {
                lastSort = spec;
                return {
                    limit: (n: number) => {
                        lastLimit = n;
                        return { lean };
                    },
                };
            },
        };
    }),
};

describe('/api/v1/points/ledger', () => {
    let app: INestApplication;
    const url = '/api/v1/points/ledger';

    beforeAll(async () => {
        app = await createShopTestApp({
            shopItem: {},
            userItem: {},
            pointLedger: pointLedgerModel,
        });
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        lastFilter = {};
        lastSort = {};
        lastLimit = 0;
        lean.mockResolvedValue([row]);
    });

    it('로그인하지 않으면 401', async () => {
        const res = await request(app.getHttpServer()).get(url);
        expect(res.status).toBe(401);
    });

    it('내 내역만 최신순으로 찾아 { data }로 돌려준다', async () => {
        const res = await request(app.getHttpServer()).get(url).set(AUTH);
        expect(res.status).toBe(200);
        expect((lastFilter.userId as Types.ObjectId).toString()).toBe(TEST_USER_ID);
        expect(lastSort).toEqual({ _id: -1 });
        expect(res.body).toEqual({
            data: [
                {
                    _id: row._id.toString(),
                    amount: 30,
                    balanceAfter: 130,
                    reasonType: 'session_complete',
                    description: null,
                    createdAt: '2026-11-01T00:00:00.000Z',
                },
            ],
        });
    });

    it('type이 없으면 amount 조건을 걸지 않는다', async () => {
        await request(app.getHttpServer()).get(url).set(AUTH);
        expect('amount' in lastFilter).toBe(false);
    });

    it('type=earn은 amount > 0, type=spend는 amount < 0', async () => {
        await request(app.getHttpServer()).get(`${url}?type=earn`).set(AUTH);
        expect(lastFilter.amount).toEqual({ $gt: 0 });

        await request(app.getHttpServer()).get(`${url}?type=spend`).set(AUTH);
        expect(lastFilter.amount).toEqual({ $lt: 0 });
    });

    it('cursor가 있으면 그 항목보다 오래된 것(_id < cursor)만 찾는다', async () => {
        const cursor = new Types.ObjectId().toString();
        const res = await request(app.getHttpServer()).get(`${url}?cursor=${cursor}`).set(AUTH);
        expect(res.status).toBe(200);
        const idFilter = lastFilter._id as { $lt: Types.ObjectId };
        expect(idFilter.$lt.toString()).toBe(cursor);
    });

    it.each([
        ['', 50],
        ['?limit=20', 20],
        ['?limit=500', 100],
        ['?limit=0', 1],
    ])('limit 처리: %s → %i건까지', async (query, expected) => {
        await request(app.getHttpServer()).get(`${url}${query}`).set(AUTH);
        expect(lastLimit).toBe(expected);
    });

    it.each(['?type=abc', '?cursor=not-an-id', '?limit=abc', '?limit=-5'])(
        '잘못된 값 %s 은 400, DB에는 묻지 않는다',
        async (query) => {
            const res = await request(app.getHttpServer()).get(`${url}${query}`).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ code: 'BAD_REQUEST', message: expect.any(String) });
            expect(pointLedgerModel.find).not.toHaveBeenCalled();
        },
    );
});