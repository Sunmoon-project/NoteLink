import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShopTestApp } from './shop-test-app.js';

const purple = {
    _id: new Types.ObjectId(),
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

// 가짜 shop_items: find(조건).sort(정렬).lean() 순서를 흉내 낸다
const lean = vi.fn();
const sort = vi.fn(() => ({ lean }));
const model = { find: vi.fn(() => ({ sort })), findOne: vi.fn() };

describe('GET /api/v1/shop/items', () => {
    let app: INestApplication;

    beforeAll(async () => {
        app = await createShopTestApp({ shopItem: model, userItem: {} });
    });

    afterAll(async () => {
        await app.close();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        lean.mockResolvedValue([purple]);
    });

    it('로그인 없이도 판매 중인 아이템을 최신순으로 돌려준다', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/shop/items');
        expect(res.status).toBe(200);
        expect(model.find).toHaveBeenCalledWith({ isActive: true });
        expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
        expect(res.body.data[0]).toMatchObject({ _id: purple._id.toString(), name: '보라', price: 700 });
    });

    it('category=theme이면 테마만 찾는다', async () => {
        await request(app.getHttpServer()).get('/api/v1/shop/items?category=theme');
        expect(model.find).toHaveBeenCalledWith({ isActive: true, category: 'theme' });
    });

    it('sort=price이면 가격 오름차순으로 정렬한다', async () => {
        await request(app.getHttpServer()).get('/api/v1/shop/items?sort=price');
        expect(sort).toHaveBeenCalledWith({ price: 1, createdAt: -1 });
    });

    it('정해지지 않은 sort 값이면 400과 { code, message }', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/shop/items?sort=abc');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ code: 'BAD_REQUEST', message: expect.any(String) });
    });
});