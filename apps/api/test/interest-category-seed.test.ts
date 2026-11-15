import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { INTEREST_CATEGORY_GROUPS } from '@notelink/shared';

import {
  isInterestSeedEnabled,
  runInterestCategorySeed,
  seedInterestCategories,
  type CategoryCollection,
} from '../src/modules/users/interest-category-seed.js';

const total = INTEREST_CATEGORY_GROUPS.reduce((n, g) => n + 1 + g.children.length, 0);
type Update = {
  $setOnInsert: { _id: Types.ObjectId; name: string; parentId: Types.ObjectId | null };
};

/** 드라이버 응답(includeResultMetadata): 새로 넣음 · 이미 있음 */
const inserted = (_id: Types.ObjectId) => ({ value: { _id }, lastErrorObject: { upserted: _id } });
const found = (_id: Types.ObjectId) => ({
  value: { _id },
  lastErrorObject: { updatedExisting: true },
});

/** 비어 있는 컬렉션처럼: 넣은 문서를 그대로 돌려준다 */
const emptyCollection = () => {
  const findOneAndUpdate = vi.fn(async (_f: object, u: Update) => inserted(u.$setOnInsert._id));
  return {
    findOneAndUpdate,
    findOne: vi.fn(),
    col: { findOneAndUpdate, findOne: vi.fn() } as unknown as CategoryCollection,
  };
};

describe('공용 관심 분야 시드', () => {
  it('빈 DB에는 큰 분야와 세부 분야를 모두 이름으로 찾아 없을 때만 넣고, 세부 분야는 큰 분야 id를 부모로 단다', async () => {
    const { findOneAndUpdate, col } = emptyCollection();
    expect(await seedInterestCategories(col)).toBe(total);
    const calls = findOneAndUpdate.mock.calls as unknown as [
      Record<string, unknown>,
      Update,
      object,
    ][];
    const ids = new Map(calls.map(([, u]) => [u.$setOnInsert.name, u.$setOnInsert._id]));
    for (const [filter, update] of calls) {
      expect(filter).toEqual({ name: update.$setOnInsert.name, ownerId: null, deletedAt: null });
      expect(Object.keys(update)).toEqual(['$setOnInsert']);
    }
    const coding = INTEREST_CATEGORY_GROUPS.find((g) => g.name === '코딩')!;
    const web = calls.find(([, u]) => u.$setOnInsert.name === coding.children[1])!;
    expect(String(web[1].$setOnInsert.parentId)).toBe(String(ids.get('코딩')));
    expect(new Set([...ids.values()].map(String)).size).toBe(total);
  });

  it('이미 있는 분야(다른 id)는 새로 세지 않고, 그 아래 세부 분야는 있던 분야를 부모로 단다', async () => {
    const existing = new Types.ObjectId();
    const findOneAndUpdate = vi.fn(async (f: { name: string }, u: Update) =>
      f.name === '어학' ? found(existing) : inserted(u.$setOnInsert._id),
    );
    const col = { findOneAndUpdate, findOne: vi.fn() } as unknown as CategoryCollection;
    expect(await seedInterestCategories(col)).toBe(total - 1);
    const toeic = (findOneAndUpdate.mock.calls as unknown as [object, Update][]).find(
      ([, u]) => u.$setOnInsert.name === '토익',
    )!;
    expect(String(toeic[1].$setOnInsert.parentId)).toBe(String(existing));
  });

  it('동시에 다른 서버가 먼저 넣은 경우(중복 키)는 그 문서를 찾아 이어 간다', async () => {
    const findOneAndUpdate = vi.fn(async (_f: object, u: Update) => {
      if (u.$setOnInsert.name === '수능') throw Object.assign(new Error('dup'), { code: 11000 });
      return inserted(u.$setOnInsert._id);
    });
    const findOne = vi.fn(async (f: { _id: Types.ObjectId }) => ({ _id: f._id }));
    const col = { findOneAndUpdate, findOne } as unknown as CategoryCollection;
    expect(await seedInterestCategories(col)).toBe(total - 1);
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it('INTEREST_SEED=off면 넣지 않고, 실패해도 서버 시작을 막지 않는다', async () => {
    expect(isInterestSeedEnabled(' OFF ')).toBe(false);
    expect(isInterestSeedEnabled(undefined)).toBe(true);
    const logger = { log: vi.fn(), error: vi.fn() };
    const { findOneAndUpdate, col } = emptyCollection();
    await runInterestCategorySeed(col, 'off', logger);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    const broken = {
      findOneAndUpdate: vi.fn().mockRejectedValue(new Error('down')),
      findOne: vi.fn(),
    };
    await expect(
      runInterestCategorySeed(broken as unknown as CategoryCollection, undefined, logger),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
  it('예전에 같은 고정 id로 넣어 둔 분야는 다시 세지 않는다(서버를 다시 켤 때)', async () => {
    const findOneAndUpdate = vi.fn(async (_f: object, u: Update) => found(u.$setOnInsert._id));
    const col = { findOneAndUpdate, findOne: vi.fn() } as unknown as CategoryCollection;
    expect(await seedInterestCategories(col)).toBe(0);
  });
});
