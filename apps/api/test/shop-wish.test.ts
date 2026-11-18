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

  it('조건부 업데이트가 반영되지 않으면(matchedCount 0) 처음 읽은 행이 아니라 같은 _id로 다시 읽은 행의 찜 상태를 응답한다', async () => {
    // 실행 순서:
    //  1) 이 요청이 isWished=false를 읽는다(뒤집으려는 값은 true)
    //  2) 다른 요청이 true로 바꾼다
    //  3) 이 요청의 조건부 갱신(조건 isWished: false)이 맞지 않아 반영되지 않는다(matchedCount 0)
    //  4) 이 요청이 같은 _id로 다시 읽어 true를 얻고 그대로 응답한다
    // 다시 읽은 행은 다른 객체 · 다른 값(true)이다: 처음 읽은 값(false)을 그대로 응답하면 실패한다
    const first = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(TEST_USER_ID),
      isWished: false,
    };
    const reread = { _id: first._id, userId: first.userId, isWished: true };
    expect(reread).not.toBe(first);
    userItemModel.findOneAndUpdate.mockReturnValueOnce({
      lean: vi.fn(() => Promise.resolve(first)),
    });
    userItemModel.updateOne.mockImplementationOnce(() =>
      Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
    );
    userItemModel.findOne.mockClear();
    userItemModel.findOne.mockReturnValueOnce({ lean: vi.fn(() => Promise.resolve(reread)) });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/shop/items/${purpleId}/wish`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { isWished: true } });
    // 처음 읽은 값(false)일 때만 뒤집으려 했고, 다시 읽기는 그 행의 _id로 불린다
    expect(userItemModel.updateOne).toHaveBeenLastCalledWith(
      { _id: first._id, isWished: false },
      { $set: { isWished: true } },
    );
    expect(userItemModel.findOne).toHaveBeenCalledTimes(1);
    expect(userItemModel.findOne).toHaveBeenCalledWith({ _id: first._id });
  });

  it('반영되지 않았을 때 다시 읽은 값이 뒤집은 값과 다르면 다시 읽은 값을 응답한다(뒤집은 값을 그대로 응답하면 실패)', async () => {
    // 실행 순서:
    //  1) 이 요청이 isWished=true를 읽는다(뒤집으려는 값은 false)
    //  2) 다른 요청이 false로 바꾼다
    //  3) 이 요청의 조건부 갱신(조건 isWished: true)이 맞지 않아 반영되지 않는다(matchedCount 0)
    //  4) 또 다른 요청이 true로 바꾼다
    //  5) 이 요청이 다시 읽어 true를 얻고 그대로 응답한다(뒤집으려던 false가 아님)
    const first = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(TEST_USER_ID),
      isWished: true,
    };
    const reread = { _id: first._id, userId: first.userId, isWished: true };
    userItemModel.findOneAndUpdate.mockReturnValueOnce({
      lean: vi.fn(() => Promise.resolve(first)),
    });
    userItemModel.updateOne.mockImplementationOnce(() =>
      Promise.resolve({ matchedCount: 0, modifiedCount: 0 }),
    );
    userItemModel.findOne.mockReturnValueOnce({ lean: vi.fn(() => Promise.resolve(reread)) });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/shop/items/${purpleId}/wish`)
      .set(AUTH);

    expect(res.body).toEqual({ data: { isWished: true } });
  });

  it('조건부 업데이트가 반영되면 뒤집은 값을 응답하고 다시 읽지 않는다', async () => {
    row!.isWished = true;
    userItemModel.findOne.mockClear();

    const res = await request(app.getHttpServer())
      .post(`/api/v1/shop/items/${purpleId}/wish`)
      .set(AUTH);

    expect(res.body).toEqual({ data: { isWished: false } });
    expect(row?.isWished).toBe(false);
    expect(userItemModel.findOne).not.toHaveBeenCalled();
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
