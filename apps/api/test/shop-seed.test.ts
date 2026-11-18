import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { ShopItem } from '../src/modules/reward/schemas/shop-item.schema.js';
import {
    isShopSeedEnabled,
    runShopSeed,
    SHOP_SEED_ITEMS,
    seedShopItems,
} from '../src/modules/reward/shop/shop-seed.js';

const fakeModel = (updateOne: ReturnType<typeof vi.fn>) => ({ updateOne }) as unknown as Model<ShopItem>;
const logger = () => ({ log: vi.fn(), error: vi.fn() });

describe('상점 기본 아이템 시드', () => {
    it('앱의 기본 상품 6개(아바타 5 · 테마 1)이고 base는 없다', () => {
        expect(SHOP_SEED_ITEMS.map((i) => i.name)).toEqual([
            '새벽 아바타',
            '지후 아바타',
            '보라 아바타',
            '하늘 아바타',
            '나래 아바타',
            '바다 테마',
        ]);
        expect(SHOP_SEED_ITEMS.map((i) => i.price)).toEqual([500, 500, 500, 500, 500, 1000]);
        expect(SHOP_SEED_ITEMS.every((i) => i.purchaseCount === 0 && i.isActive && !i.isDefault)).toBe(true);
        expect(new Set(SHOP_SEED_ITEMS.map((i) => i.id)).size).toBe(6);
        expect(SHOP_SEED_ITEMS.every((i) => /^[0-9a-f]{24}$/.test(i.id))).toBe(true);
    });

    it('6개를 고정 id로 upsert하고 $setOnInsert만 쓴다', async () => {
        const updateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 });
        const inserted = await seedShopItems(fakeModel(updateOne));

        expect(inserted).toBe(6);
        expect(updateOne).toHaveBeenCalledTimes(6);
        updateOne.mock.calls.forEach(([filter, update, options], i) => {
            expect(String(filter._id)).toBe(SHOP_SEED_ITEMS[i]!.id);
            expect(Object.keys(update)).toEqual(['$setOnInsert']);
            expect(update.$setOnInsert).not.toHaveProperty('id');
            expect(update.$setOnInsert.name).toBe(SHOP_SEED_ITEMS[i]!.name);
            expect(options).toEqual({ upsert: true, timestamps: false });
        });
    });

    it('이미 있어서 새로 넣지 않으면 0을 돌려주고, 동시에 켜져 중복 키가 나도 넘어간다', async () => {
        const updateOne = vi
            .fn()
            .mockResolvedValueOnce({ upsertedCount: 0 })
            .mockRejectedValueOnce({ code: 11000 })
            .mockResolvedValue({ upsertedCount: 0 });
        await expect(seedShopItems(fakeModel(updateOne))).resolves.toBe(0);
        expect(updateOne).toHaveBeenCalledTimes(6);
    });

    it('SHOP_SEED=off면 DB에 아무것도 하지 않는다', async () => {
        const updateOne = vi.fn();
        await runShopSeed(fakeModel(updateOne), 'off', logger());
        await runShopSeed(fakeModel(updateOne), ' OFF ', logger());
        expect(updateOne).not.toHaveBeenCalled();
        expect(isShopSeedEnabled(undefined)).toBe(true);
        expect(isShopSeedEnabled('')).toBe(true);
        expect(isShopSeedEnabled('on')).toBe(true);
    });

    it('켜져 있으면 시드를 돌린다', async () => {
        const updateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 });
        await runShopSeed(fakeModel(updateOne), undefined, logger());
        expect(updateOne).toHaveBeenCalledTimes(6);
    });

    it('DB가 실패해도 예외를 밖으로 내지 않고 로그만 남긴다', async () => {
        const log = logger();
        const updateOne = vi.fn().mockRejectedValue(new Error('연결 끊김'));
        await expect(runShopSeed(fakeModel(updateOne), undefined, log)).resolves.toBeUndefined();
        expect(log.error).toHaveBeenCalledOnce();
        // 가짜 모델에 updateOne이 없어도(다른 테스트의 가짜 연결) 서버 시작을 막지 않는다
        await expect(runShopSeed({} as Model<ShopItem>, undefined, logger())).resolves.toBeUndefined();
    });
});
