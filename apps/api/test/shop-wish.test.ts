import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTH, createShopTestApp, TEST_USER_ID } from './shop-test-app.js';

const purpleId = new Types.ObjectId().toString();
const purple = {
    _id: new Types.ObjectId(purpleId),
    category: 'avatar',
    name: '보라',
    description: null,
    price: 700,
    avatarStyle: 'purple',
    thumbnailUrl: null,
    assetUrl: 'avatars/purple.png',
    purchaseCount: 10,
    isActive: true,
    isDefault: false,
    badge: 'NEW',
};

// 가짜 shop_items: purpleId로 찾을 때만 아이템이 있다
const shopItemModel = {
    find: vi.fn(),
    findOne: vi.fn((filter: { _id: string }) => ({
        lean: vi.fn().mockResolvedValue(filter._id === purpleId ? purple : null),
    })),
};

// 가짜 user_items: 행 하나만 기억한다
let row: { _id: Types.ObjectId; userId: Types.ObjectId; isWished: boolean } | null = null;
const userItemModel = {
    findOneAndUpdate: vi.fn((filter: { userId: Types.ObjectId }) => ({
        lean: vi.fn(() => {
            row ??= { _id: new Types.ObjectId(), userId: filter.userId, isWished: false };
            return Promise.resolve(row);
        }),
    })),
    updateOne: vi.fn((filter: { isWished: boolean }, update: { $set: { isWished: boolean } }) => {
        if (row && row.isWished === filter.isWished) row.isWished = update.$set.isWished;
        return Promise.resolve({ modifiedCount: 1 });
    }),
    findOne: vi.fn(),
};

describe('POST /api/v1/shop/items/:itemId/wish', () => {
    let app: INestApplication;

    beforeAll(async () => {
        app = await createShopTestApp({ shopItem: shopItemModel, userItem: userItemModel });
    });

    afterAll(async () => {
        await app.close();
    });

    it('로그인하지 않으면 401과 { code, message }', async () => {
        const res = await request(app.getHttpServer()).post(`/api/v1/shop/items/${purpleId}/wish`);
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
    });

    it('처음 누르면 찜이 켜지고, 로그인한 사람의 행이 생긴다', async () => {
        const res = await request(app.getHttpServer())
            .post(`/api/v1/shop/items/${purpleId}/wish`)
            .set(AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ data: { isWished: true } });
        expect(shopItemModel.findOne).toHaveBeenCalledWith({ _id: purpleId, isActive: true });
        expect(row?.userId.toString()).toBe(TEST_USER_ID);
    });

    it('다시 누르면 찜이 꺼진다', async () => {
        const res = await request(app.getHttpServer())
            .post(`/api/v1/shop/items/${purpleId}/wish`)
            .set(AUTH);
        expect(res.body).toEqual({ data: { isWished: false } });
    });

    it('없는 아이템이면 404와 { code, message }', async () => {
        const otherId = new Types.ObjectId().toString();
        const res = await request(app.getHttpServer())
            .post(`/api/v1/shop/items/${otherId}/wish`)
            .set(AUTH);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
    });

    it('ID 모양이 틀리면 DB에 묻지 않고 404', async () => {
        shopItemModel.findOne.mockClear();
        const res = await request(app.getHttpServer())
            .post('/api/v1/shop/items/not-an-id/wish')
            .set(AUTH);
        expect(res.status).toBe(404);
        expect(shopItemModel.findOne).not.toHaveBeenCalled();
    });
});