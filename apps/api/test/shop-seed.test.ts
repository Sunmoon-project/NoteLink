import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { ShopItem } from '../src/modules/reward/schemas/shop-item.schema.js';
import {
    isShopSeedEnabled,
    runShopSeed,
    SHOP_SEED_ITEMS,
    seedShopItems,
} from '../src/modules/reward/shop/shop-seed.js';

const fakeModel = (updateOne: ReturnType<typeof vi.fn>, updateMany = vi.fn().mockResolvedValue({ modifiedCount: 0 })) =>
    ({ updateOne, updateMany }) as unknown as Model<ShopItem>;
const N = 11;
const logger = () => ({ log: vi.fn(), error: vi.fn() });

describe('상점 기본 아이템 시드', () => {
    it('앱의 기본 상품 11개(아바타 5 · 테마 1 · 치장 5)이고 base는 없다', () => {
        expect(SHOP_SEED_ITEMS.map((i) => i.name)).toEqual([
            '새벽 아바타',
            '지후 아바타',
            '보라 아바타',
            '하늘 아바타',
            '나래 아바타',
            '바다 테마',
            '동그란 안경',
            '선글라스',
            '털모자',
            '학사모',
            '빨간 목도리',
        ]);
        expect(SHOP_SEED_ITEMS.map((i) => i.price)).toEqual([500, 500, 500, 500, 500, 1000, 300, 300, 400, 600, 400]);
        expect(SHOP_SEED_ITEMS.slice(6).map((i) => i.category)).toEqual(['glasses', 'glasses', 'hat', 'hat', 'scarf']);
        // 앱이 고정 id로 모양을 찾는다(apps/mobile accessories · shop-themes)
        expect(SHOP_SEED_ITEMS.slice(5).map((i) => i.id.slice(-2))).toEqual(['06', '07', '08', '09', '10', '11']);
        expect(SHOP_SEED_ITEMS.every((i) => i.purchaseCount === 0 && i.isActive && !i.isDefault)).toBe(true);
        expect(new Set(SHOP_SEED_ITEMS.map((i) => i.id)).size).toBe(N);
        expect(SHOP_SEED_ITEMS.every((i) => /^[0-9a-f]{24}$/.test(i.id))).toBe(true);
    });

    it('바다 테마 설명은 실제 동작(앱 바탕색)과 맞다', () => {
        expect(SHOP_SEED_ITEMS.find((i) => i.name === '바다 테마')!.description).toBe('앱 바탕이 시원한 바다색으로 바뀌어요.');
    });

    it('이미 넣은 DB의 옛 바다 테마 설명은 옛 문구 그대로일 때만 새 문구로 바꾼다(운영자가 고친 문구는 그대로)', async () => {
        const updateMany = vi.fn().mockResolvedValue({ modifiedCount: 1 });
        await seedShopItems(fakeModel(vi.fn().mockResolvedValue({ upsertedCount: 0 }), updateMany));
        expect(updateMany).toHaveBeenCalledTimes(1);
        const [filter, update, options] = updateMany.mock.calls[0]!;
        // timestamps를 끄지 않아 문구가 바뀌면 updatedAt도 새로 된다
        expect(String(filter._id)).toBe(SHOP_SEED_ITEMS[5]!.id);
        expect(filter.description).toBe('시원한 파란 물결이 앱 전체를 감싸요.');
        expect(update).toEqual({ $set: { description: '앱 바탕이 시원한 바다색으로 바뀌어요.' } });
        expect(options).toBeUndefined();
    });

    it('11개를 고정 id로 upsert하고 $setOnInsert만 쓴다', async () => {
        const updateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 });
        const inserted = await seedShopItems(fakeModel(updateOne));

        expect(inserted).toBe(N);
        expect(updateOne).toHaveBeenCalledTimes(N);
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
        expect(updateOne).toHaveBeenCalledTimes(N);
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
        expect(updateOne).toHaveBeenCalledTimes(N);
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
