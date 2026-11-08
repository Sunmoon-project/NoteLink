import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH, createShopTestApp, TEST_USER_ID } from './shop-test-app.js';

// 로그인한 사람이 보유한 아바타 하나
const owned = {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(TEST_USER_ID),
    itemId: new Types.ObjectId(),
    itemCategory: 'avatar',
    isOwned: true,
    isWished: false,
    isEquipped: false,
    acquiredAt: new Date('2026-11-01T00:00:00.000Z'),
};

// 가짜 user_items
let findUserId = '';
const lean = vi.fn();
const userItemModel = {
    find: vi.fn((filter: { userId: Types.ObjectId }) => {
        findUserId = filter.userId.toString();
        return { sort: vi.fn(() => ({ lean })) };
    }),
    // 보유한 아바타의 itemId로 찾을 때만 있다고 대답한다
    findOne: vi.fn((filter: { itemId: Types.ObjectId }) => ({
        lean: vi.fn().mockResolvedValue(filter.itemId.equals(owned.itemId) ? owned : null),
    })),
    updateMany: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
};

// 트랜잭션의 가짜 session. 장착의 쓰기들이 한 묶음으로 가는지 확인한다
const session = { id: 'fake-session' };
const connection = {
    transaction: vi.fn((work: (s: typeof session) => Promise<unknown>) => work(session)),
};

describe('/api/v1/users/me/items', () => {
    let app: INestApplication;

    beforeAll(async () => {
        app = await createShopTestApp({ shopItem: {}, userItem: userItemModel, connection });
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        lean.mockResolvedValue([owned]);
    });

    it('로그인하지 않으면 401', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/users/me/items');
        expect(res.status).toBe(401);
    });

    it('로그인한 사람의 아이템만 찾아 { data }로 돌려준다', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/users/me/items').set(AUTH);
        expect(res.status).toBe(200);
        expect(findUserId).toBe(TEST_USER_ID);
        expect(res.body).toEqual({
            data: [
                {
                    _id: owned._id.toString(),
                    itemId: owned.itemId.toString(),
                    itemCategory: 'avatar',
                    isOwned: true,
                    isWished: false,
                    isEquipped: false,
                    acquiredAt: '2026-11-01T00:00:00.000Z',
                },
            ],
        });
    });

    it('보유한 아이템을 장착하면 204, 같은 종류의 다른 장착은 해제한다', async () => {
        const res = await request(app.getHttpServer())
            .post(`/api/v1/users/me/items/${owned.itemId.toString()}/equip`)
            .set(AUTH);
        expect(res.status).toBe(204);
        // 해제와 장착이 같은 트랜잭션(session)으로 간다
        expect(connection.transaction).toHaveBeenCalledTimes(1);
        expect(userItemModel.findOne).toHaveBeenCalledWith(expect.anything(), null, { session });
        expect(userItemModel.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ itemCategory: 'avatar', isEquipped: true }),
            { $set: { isEquipped: false } },
            { session },
        );
        expect(userItemModel.updateOne).toHaveBeenCalledWith(
            { _id: owned._id },
            { $set: { isEquipped: true } },
            { session },
        );
    });

    it('기본 아바타(base)를 장착하면 204, 장착 중인 아바타만 모두 해제하고 테마는 건드리지 않는다', async () => {
        const res = await request(app.getHttpServer())
            .post('/api/v1/users/me/items/base/equip')
            .set(AUTH);
        expect(res.status).toBe(204);
        expect(userItemModel.updateMany).toHaveBeenCalledTimes(1);
        expect(userItemModel.updateMany).toHaveBeenCalledWith(
            { userId: new Types.ObjectId(TEST_USER_ID), itemCategory: 'avatar', isEquipped: true },
            { $set: { isEquipped: false } },
        );
        // 보유 행을 찾거나 장착 표시를 따로 하지 않는다 (기본 아바타는 DB 아이템이 아님)
        expect(userItemModel.findOne).not.toHaveBeenCalled();
        expect(userItemModel.updateOne).not.toHaveBeenCalled();
        expect(connection.transaction).not.toHaveBeenCalled();
    });

    it('보유하지 않은 아이템이면 404와 { code, message }, 아무것도 바꾸지 않는다', async () => {
        const otherId = new Types.ObjectId().toString();
        const res = await request(app.getHttpServer())
            .post(`/api/v1/users/me/items/${otherId}/equip`)
            .set(AUTH);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        expect(userItemModel.updateMany).not.toHaveBeenCalled();
        expect(userItemModel.updateOne).not.toHaveBeenCalled();
    });

    it('ID 모양이 틀리면 DB에 묻지 않고 404', async () => {
        const res = await request(app.getHttpServer())
            .post('/api/v1/users/me/items/not-an-id/equip')
            .set(AUTH);
        expect(res.status).toBe(404);
        expect(userItemModel.findOne).not.toHaveBeenCalled();
        expect(connection.transaction).not.toHaveBeenCalled();
    });
});