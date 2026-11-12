import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { expect, it, vi } from 'vitest';
import { UsersService } from '../src/modules/users/users.service.js';

it('활성 공용 분야를 정렬해 부모 ID와 함께 반환한다', async () => {
  const parent = new Types.ObjectId();
  const child = new Types.ObjectId();
  const sort = vi.fn(() => ({
    toArray: async () => [
      { _id: parent, name: '코딩', parentId: null },
      { _id: child, name: '기초', parentId: parent },
    ],
  }));
  const find = vi.fn(() => ({ sort }));
  const service = new UsersService({ db: { collection: () => ({ find }) } } as never);
  expect(await service.interestCategories()).toEqual([
    { _id: String(parent), name: '코딩', parentId: null },
    { _id: String(child), name: '기초', parentId: String(parent) },
  ]);
  expect(find).toHaveBeenCalledWith({ ownerId: null, isActive: true, deletedAt: null });
  expect(sort).toHaveBeenCalledWith({ sortOrder: 1, _id: 1 });
});

it('여러 상위·하위 ID를 모두 검증하고 ObjectId 배열로 저장한다', async () => {
  const parent = new Types.ObjectId();
  const child = new Types.ObjectId();
  const countDocuments = vi.fn().mockResolvedValue(2);
  const findOneAndUpdate = vi.fn().mockResolvedValue({
    _id: new Types.ObjectId(),
    nickname: '학생',
    interestCategoryIds: [parent, child],
    settings: {},
    createdAt: new Date(),
  });
  const service = new UsersService({
    db: { collection: () => ({ countDocuments }) },
    findOneAndUpdate,
  } as never);
  const userId = new Types.ObjectId();
  await service.updateProfile(String(userId), {
    interestCategoryIds: [String(parent), String(child)],
  });
  expect(countDocuments).toHaveBeenCalledWith({
    _id: { $in: [parent, child] },
    isActive: true,
    deletedAt: null,
  });
  expect(findOneAndUpdate).toHaveBeenCalledWith(
    expect.anything(),
    { $set: { interestCategoryIds: [parent, child] } },
    expect.anything(),
  );
  countDocuments.mockResolvedValueOnce(1);
  await expect(
    service.updateProfile(String(userId), { interestCategoryIds: [String(parent), String(child)] }),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
});
