import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH, createShopTestApp, TEST_USER_ID } from './shop-test-app.js';

const purpleId = new Types.ObjectId();
const freeId = new Types.ObjectId();
const items = [
    { _id: purpleId, category: 'avatar', name: '보라', price: 700, isActive: true },
    { _id: freeId, category: 'theme', name: '무료 테마', price: 0, isActive: true },
];

// 트랜잭션의 가짜 session. 모든 쓰기에 이 session이 따라가는지 확인한다
const session = { id: 'fake-session' };

// 가짜 DB 상태 (테스트마다 초기화)
let balance = 1000;
let ownedRow = false;

const shopItemModel = {
    // 문자열 ID(앞 조회)와 ObjectId(트랜잭션 안 재조회) 둘 다 받는다
    findOne: vi.fn((filter: { _id: string | Types.ObjectId }) => ({
        lean: vi.fn().mockResolvedValue(items.find((i) => i._id.toString() === String(filter._id)) ?? null),
    })),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
};
const userItemModel = {
    exists: vi.fn(() => ({ session: vi.fn(() => Promise.resolve(ownedRow ? { _id: new Types.ObjectId() } : null)) })),
    updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }),
};
// 잔액이 price 이상일 때만 줄이고 새 잔액을 돌려준다 (진짜 DB의 조건부 업데이트 흉내)
const userModel = {
    findOneAndUpdate: vi.fn(
        (filter: { pointBalance: { $gte: number } }, update: { $inc: { pointBalance: number } }) => ({
            lean: vi.fn(() => {
                if (balance < filter.pointBalance.$gte) return Promise.resolve(null);
                balance += update.$inc.pointBalance;
                return Promise.resolve({ pointBalance: balance });
            }),
        }),
    ),
};
const pointLedgerModel = { create: vi.fn().mockResolvedValue([]) };
const connection = {
    transaction: vi.fn((work: (s: typeof session) => Promise<unknown>) => work(session)),
};

describe('POST /api/v1/shop/purchases', () => {
    let app: INestApplication;

    beforeAll(async () => {
        app = await createShopTestApp({
            shopItem: shopItemModel,
            userItem: userItemModel,
            pointLedger: pointLedgerModel,
            user: userModel,
            connection,
        });
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        balance = 1000;
        ownedRow = false;
    });

    const buy = (body: object) =>
        request(app.getHttpServer()).post('/api/v1/shop/purchases').set(AUTH).send(body);

    it('로그인하지 않으면 401과 { code, message }', async () => {
        const res = await request(app.getHttpServer())
            .post('/api/v1/shop/purchases')
            .send({ itemId: purpleId.toString() });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
    });

    it('구매하면 남은 잔액을 돌려주고, 장부·보유·구매수가 한 묶음으로 반영된다', async () => {
        const res = await buy({ itemId: purpleId.toString() });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ data: { balance: 300 } });
        expect(connection.transaction).toHaveBeenCalledTimes(1);

        // 로그인한 사람의 잔액에서 가격만큼, 모자라지 않을 때만 차감
        expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: new Types.ObjectId(TEST_USER_ID), pointBalance: { $gte: 700 } },
            { $inc: { pointBalance: -700 } },
            { returnDocument: 'after', session },
        );
        // 장부: 사용은 음수, 차감 뒤 잔액 기록
        expect(pointLedgerModel.create).toHaveBeenCalledWith(
            [
                {
                    userId: new Types.ObjectId(TEST_USER_ID),
                    amount: -700,
                    balanceAfter: 300,
                    reasonType: 'purchase',
                    description: '보라 구매',
                },
            ],
            { session },
        );
        // 보유: 찜 행이 있어도 없어도 되는 upsert
        expect(userItemModel.updateOne).toHaveBeenCalledWith(
            { userId: new Types.ObjectId(TEST_USER_ID), itemId: purpleId },
            {
                $set: { itemCategory: 'avatar', isOwned: true, acquiredAt: expect.any(Date) },
                $setOnInsert: { isWished: false, isEquipped: false },
            },
            { upsert: true, session },
        );
        // 인기순 기준 구매수 +1
        expect(shopItemModel.updateOne).toHaveBeenCalledWith(
            { _id: purpleId },
            { $inc: { purchaseCount: 1 } },
            { session },
        );
        // 가격은 트랜잭션 안에서 다시 읽는다
        expect(shopItemModel.findOne).toHaveBeenLastCalledWith({ _id: purpleId, isActive: true }, null, { session });
    });

    it('앞에서 읽은 뒤 가격이 바뀌었으면 트랜잭션 안에서 읽은 새 가격으로 차감한다', async () => {
        const lean = (value: object | null) => ({ lean: vi.fn().mockResolvedValue(value) });
        shopItemModel.findOne
            .mockImplementationOnce(() => lean(items[0] ?? null)) // 앞 조회: 700
            .mockImplementationOnce(() => lean({ ...items[0], price: 900 })); // 트랜잭션 안: 900

        const res = await buy({ itemId: purpleId.toString() });

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ data: { balance: 100 } });
        expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ pointBalance: { $gte: 900 } }),
            { $inc: { pointBalance: -900 } },
            expect.anything(),
        );
    });

    it('앞에서 읽은 뒤 판매가 중지됐으면 404, 포인트는 건드리지 않는다', async () => {
        const lean = (value: object | null) => ({ lean: vi.fn().mockResolvedValue(value) });
        shopItemModel.findOne
            .mockImplementationOnce(() => lean(items[0] ?? null))
            .mockImplementationOnce(() => lean(null));

        const res = await buy({ itemId: purpleId.toString() });

        expect(res.status).toBe(404);
        expect(userModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(userItemModel.updateOne).not.toHaveBeenCalled();
    });

    it('이미 보유한 아이템이면 409 ITEM_ALREADY_OWNED, 포인트는 건드리지 않는다', async () => {
        ownedRow = true;
        const res = await buy({ itemId: purpleId.toString() });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({ code: 'ITEM_ALREADY_OWNED', message: expect.any(String) });
        expect(userModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(pointLedgerModel.create).not.toHaveBeenCalled();
        expect(userItemModel.updateOne).not.toHaveBeenCalled();
        expect(balance).toBe(1000);
    });

    it('포인트가 모자라면 400 POINTS_INSUFFICIENT, 보유·장부·구매수는 바뀌지 않는다', async () => {
        balance = 500;
        const res = await buy({ itemId: purpleId.toString() });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ code: 'POINTS_INSUFFICIENT', message: expect.any(String) });
        expect(pointLedgerModel.create).not.toHaveBeenCalled();
        expect(userItemModel.updateOne).not.toHaveBeenCalled();
        expect(shopItemModel.updateOne).not.toHaveBeenCalled();
        expect(balance).toBe(500);
    });

    it('잔액이 딱 가격만큼이면 구매되고 잔액은 0', async () => {
        balance = 700;
        const res = await buy({ itemId: purpleId.toString() });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ data: { balance: 0 } });
    });

    it('0포인트 아이템은 구매되지만 장부에는 남기지 않는다', async () => {
        const res = await buy({ itemId: freeId.toString() });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ data: { balance: 1000 } });
        expect(pointLedgerModel.create).not.toHaveBeenCalled();
        expect(userItemModel.updateOne).toHaveBeenCalledTimes(1);
    });

    it('없는 아이템이면 404와 { code, message }, 트랜잭션도 시작하지 않는다', async () => {
        const res = await buy({ itemId: new Types.ObjectId().toString() });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        expect(connection.transaction).not.toHaveBeenCalled();
    });

    it('itemId가 없거나 ID 모양이 아니거나 모르는 필드가 있으면 400', async () => {
        expect((await buy({})).status).toBe(400);
        expect((await buy({ itemId: 'not-an-id' })).status).toBe(400);
        expect((await buy({ itemId: purpleId.toString(), price: 1 })).status).toBe(400);
        expect(connection.transaction).not.toHaveBeenCalled();
    });
});
