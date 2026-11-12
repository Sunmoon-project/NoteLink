import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { ProgressService } from '../src/modules/progress/progress.service.js';
import { UsersController } from '../src/modules/users/users.controller.js';
import { UsersService } from '../src/modules/users/users.service.js';

const userId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();
const activeId = new Types.ObjectId();
const inactiveId = new Types.ObjectId();
const deletedId = new Types.ObjectId();
let user: Record<string, unknown> | null;
const streakDays = vi.fn(async (_userId: string) => 0);
const categoryCount = vi.fn(
  async (filter: { _id: { $in: Types.ObjectId[] }; isActive: boolean; deletedAt: null }) => {
    const categories = [
      { _id: activeId, isActive: true, deletedAt: null },
      { _id: inactiveId, isActive: false, deletedAt: null },
      { _id: deletedId, isActive: true, deletedAt: new Date() },
    ];
    return categories.filter(
      (c) =>
        filter._id.$in.some((id) => id.equals(c._id)) &&
        c.isActive === filter.isActive &&
        c.deletedAt === filter.deletedAt,
    ).length;
  },
);
const model = {
  db: {
    collection: vi.fn(() => ({
      countDocuments: categoryCount,
      find: vi.fn(() => ({
        sort: () => ({ toArray: async () => [{ _id: activeId, name: '수능' }] }),
      })),
    })),
  },
  findOne: vi.fn(async () => user),
  findOneAndUpdate: vi.fn(async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
    if (!user) return null;
    if (update.$set.nickname === '중복닉네임') throw { code: 11000, keyPattern: { nickname: 1 } };
    for (const [key, value] of Object.entries(update.$set)) {
      if (key.startsWith('settings.')) {
        (user.settings as Record<string, unknown>)[key.slice('settings.'.length)] = value;
      } else {
        user[key] = value;
      }
    }
    return user;
  }),
};
let app: INestApplication;
beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [UsersController],
    providers: [
      UsersService,
      { provide: getModelToken(User.name), useValue: model },
      { provide: ProgressService, useValue: { streakDays } },
      {
        provide: TokenService,
        useValue: {
          verifyAccess: (token: string) =>
            token === 'valid' || token === 'other'
              ? Promise.resolve({ userId: String(token === 'valid' ? userId : otherUserId) })
              : Promise.reject(new UnauthorizedException()),
        },
      },
    ],
  }).compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  streakDays.mockResolvedValue(0);
  user = {
    _id: userId,
    nickname: '기존닉네임',
    learnerType: 'worker',
    interestCategoryIds: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    settings: { keepScreenOnWhileRecording: true, offlineCache: false },
  };
});
const get = () =>
  request(app.getHttpServer()).get('/api/v1/users/me').set('Authorization', 'Bearer valid');
const patch = (body: unknown) =>
  request(app.getHttpServer())
    .patch('/api/v1/users/me')
    .set('Authorization', 'Bearer valid')
    .send(body as object);

describe('내 프로필 API', () => {
  it('인증한 사용자에게 선택 가능한 카테고리 ID를 반환한다', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/v1/users/interest-categories')).status,
    ).toBe(401);
    const result = await request(app.getHttpServer())
      .get('/api/v1/users/interest-categories')
      .set('Authorization', 'Bearer valid');
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual([{ _id: String(activeId), name: '수능', parentId: null }]);
  });
  it('인증한 사용자를 조회하고 비밀번호를 반환하지 않는다', async () => {
    user!.passwordHash = 'secret';
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ _id: String(userId), nickname: '기존닉네임' });
    expect(res.body.data).not.toHaveProperty('passwordHash');
    expect(model.findOne).toHaveBeenCalledWith({ _id: userId, deletedAt: null });
  });
  it('GET·PATCH 모두 연속 학습일(streakDays)을 학습 기록에서 계산한 실제 값으로 내려준다', async () => {
    streakDays.mockResolvedValue(7);
    const res = await get();
    expect(res.body.data.streakDays).toBe(7);
    expect(streakDays).toHaveBeenCalledWith(String(userId));
    const patched = await patch({ nickname: '새닉네임' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.streakDays).toBe(7);
  });
  it('미인증 요청과 삭제되거나 없는 사용자를 거부한다', async () => {
    expect((await request(app.getHttpServer()).get('/api/v1/users/me')).status).toBe(401);
    expect(
      (await request(app.getHttpServer()).patch('/api/v1/users/me').send({ nickname: '닉네임' }))
        .status,
    ).toBe(401);
    user = null;
    expect((await get()).status).toBe(404);
    expect((await patch({ nickname: '새닉네임' })).status).toBe(404);
  });
  it('닉네임과 설정을 부분 수정하며 다른 필드를 덮지 않는다', async () => {
    expect((await patch({ nickname: '새닉네임' })).status).toBe(200);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { nickname: '새닉네임' } },
      expect.anything(),
    );
    const result = await patch({ settings: { offlineCache: true } });
    expect(result.status).toBe(200);
    expect(result.body.data.settings).toMatchObject({
      offlineCache: true,
      keepScreenOnWhileRecording: true,
    });
    expect(model.findOneAndUpdate).toHaveBeenLastCalledWith(
      expect.anything(),
      { $set: { 'settings.offlineCache': true } },
      expect.anything(),
    );
    expect((await patch({})).status).toBe(400);
    expect((await patch({ nickname: null })).status).toBe(400);
    expect((await patch({ settings: { role: 'admin' } })).status).toBe(400);
  });
  it('활성 카테고리는 허용하고 비활성·삭제·없는 카테고리는 거부한다', async () => {
    expect((await patch({ interestCategoryIds: [String(activeId)] })).status).toBe(200);
    for (const id of [inactiveId, deletedId, new Types.ObjectId()]) {
      const res = await patch({ interestCategoryIds: [String(id)] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CATEGORY');
    }
    expect(categoryCount).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true, deletedAt: null }),
    );
    expect((await patch({ interestCategoryIds: [] })).status).toBe(200);
  });
  it('닉네임 유일 인덱스 충돌을 409로 반환한다', async () => {
    const res = await patch({ nickname: '중복닉네임' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NICKNAME_TAKEN');
  });
  it('두 사용자가 같은 닉네임을 동시에 요청하면 DB 중복 오류를 한쪽에 반환한다', async () => {
    let claimed = false;
    model.findOneAndUpdate
      .mockImplementationOnce(async (filter: unknown) => {
        if (claimed) throw { code: 11000, keyPattern: { nickname: 1 } };
        claimed = true;
        return { ...user, _id: (filter as { _id: Types.ObjectId })._id, nickname: '같은닉네임' };
      })
      .mockImplementationOnce(async (filter: unknown) => {
        if (claimed) throw { code: 11000, keyPattern: { nickname: 1 } };
        claimed = true;
        return { ...user, _id: (filter as { _id: Types.ObjectId })._id, nickname: '같은닉네임' };
      });
    const send = (token: string) =>
      request(app.getHttpServer())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ nickname: '같은닉네임' });
    const results = await Promise.all([send('valid'), send('other')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe('NICKNAME_TAKEN');
  });
  it('다른 인덱스 충돌은 닉네임 중복으로 잘못 표시하지 않는다', async () => {
    model.findOneAndUpdate.mockRejectedValueOnce({ code: 11000, keyPattern: { email: 1 } });
    expect((await patch({ nickname: '새닉네임' })).status).toBe(500);
  });
});

describe('관심 분야는 공용 카테고리만 저장한다 (#287 리뷰)', () => {
  const publicId = new Types.ObjectId();
  const otherOwnerId = new Types.ObjectId();
  // ownerId까지 보는 카테고리 목업. 다른 사용자가 만든 활성 카테고리(otherOwnerId)가 섞여 있다
  const useCategories = () =>
    categoryCount.mockImplementation(
      async (filter: {
        _id: { $in: Types.ObjectId[] };
        ownerId?: null;
        isActive: boolean;
        deletedAt: null;
      }) => {
        const categories = [
          { _id: publicId, ownerId: null, isActive: true, deletedAt: null },
          { _id: otherOwnerId, ownerId: new Types.ObjectId(), isActive: true, deletedAt: null },
        ];
        return categories.filter(
          (c) =>
            filter._id.$in.some((id) => id.equals(c._id)) &&
            (filter.ownerId === undefined || filter.ownerId === c.ownerId) &&
            c.isActive === filter.isActive &&
            c.deletedAt === filter.deletedAt,
        ).length;
      },
    );

  it('다른 사용자가 만든 카테고리를 보내면 400 INVALID_CATEGORY이고 저장하지 않는다', async () => {
    useCategories();
    const res = await patch({ interestCategoryIds: [String(otherOwnerId)] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CATEGORY');
    expect(categoryCount).toHaveBeenCalledWith(expect.objectContaining({ ownerId: null }));
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    // 공용 + 남의 카테고리를 같이 보내도 전체가 거부된다
    expect(
      (await patch({ interestCategoryIds: [String(publicId), String(otherOwnerId)] })).status,
    ).toBe(400);
  });

  it('공용 카테고리는 그대로 저장한다', async () => {
    useCategories();
    const res = await patch({ interestCategoryIds: [String(publicId)] });
    expect(res.status).toBe(200);
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { interestCategoryIds: [publicId] } },
      expect.anything(),
    );
  });

  it('같은 ID가 (대소문자만 달라도) 중복으로 와도 한 번만 검사하고 저장한다', async () => {
    useCategories();
    const hex = String(publicId);
    const res = await patch({ interestCategoryIds: [hex, hex.toUpperCase()] });
    expect(res.status).toBe(200);
    expect(categoryCount).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [publicId] } }));
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { interestCategoryIds: [publicId] } },
      expect.anything(),
    );
  });
});
