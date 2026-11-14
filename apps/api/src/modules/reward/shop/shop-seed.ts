import { Logger } from '@nestjs/common';
import { Types, type Model } from 'mongoose';

import type { ShopItem } from '../schemas/shop-item.schema.js';

/** 시드 끄기용 환경 변수 이름. 값이 off면 서버를 켜도 기본 아이템을 넣지 않는다 (기본은 켜짐) */
export const SHOP_SEED_ENV = 'SHOP_SEED';

/** 시드로 넣는 아이템 한 건. 고정 id(24자리 16진수)가 같은 아이템을 가리키는 열쇠다 */
export interface ShopSeedItem extends ShopItem {
    id: string;
}

// 고정 id 앞부분: "notelinksh"를 16진수로 쓴 값(20자리) + 번호 4자리. 서버가 몇 대 켜져도 같은 id라 중복이 생기지 않는다
const idOf = (n: number) => `6e6f74656c696e6b7368${String(n).padStart(4, '0')}`;

/**
 * 상점 기본 아이템 6개. 앱의 기본 상품 목록(apps/mobile/src/lib/local/catalog.ts SHOP)과 같은 값이다.
 * 기본 아바타 'base'는 서버가 특별 처리(장착 해제)하므로 넣지 않는다. purchaseCount는 0에서 시작한다
 */
export const SHOP_SEED_ITEMS: readonly ShopSeedItem[] = [
    {
        id: idOf(1),
        category: 'avatar',
        name: '새벽 아바타',
        description: '짧은 머리가 깔끔한 스타일이에요.',
        price: 500,
        avatarStyle: 'nice',
        thumbnailUrl: '🧑🏽',
        assetUrl: '🧑🏽',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: 'NEW',
    },
    {
        id: idOf(2),
        category: 'avatar',
        name: '지후 아바타',
        description: '단정한 교복 스타일이에요.',
        price: 500,
        avatarStyle: 'nice',
        thumbnailUrl: '👨🏻',
        assetUrl: '👨🏻',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: 'BEST',
    },
    {
        id: idOf(3),
        category: 'avatar',
        name: '보라 아바타',
        description: '머리를 묶은 발랄한 스타일이에요.',
        price: 500,
        avatarStyle: 'nice',
        thumbnailUrl: '👧🏻',
        assetUrl: '👧🏻',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
    {
        id: idOf(4),
        category: 'avatar',
        name: '하늘 아바타',
        description: '긴 생머리 스타일이에요.',
        price: 500,
        avatarStyle: 'nice',
        thumbnailUrl: '👩🏻',
        assetUrl: '👩🏻',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
    {
        id: idOf(5),
        category: 'avatar',
        name: '나래 아바타',
        description: '곱슬머리가 귀여운 스타일이에요.',
        price: 500,
        avatarStyle: 'nice',
        thumbnailUrl: '👩🏼‍🦱',
        assetUrl: '👩🏼‍🦱',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
    {
        id: idOf(6),
        category: 'theme',
        name: '바다 테마',
        description: '시원한 파란 물결이 앱 전체를 감싸요.',
        price: 1000,
        avatarStyle: null,
        thumbnailUrl: '🌊',
        assetUrl: '🌊',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
];

/** SHOP_SEED=off(대소문자 무시)일 때만 끈다. 비어 있거나 다른 값이면 켜짐 */
export function isShopSeedEnabled(value: string | undefined): boolean {
    return value?.trim().toLowerCase() !== 'off';
}

// 동시에 켜진 다른 서버가 먼저 넣었을 때 나는 중복 키 오류(이미 있다는 뜻이라 괜찮다)
const DUPLICATE_KEY = 11000;
const isDuplicateKey = (e: unknown) => (e as { code?: number } | null)?.code === DUPLICATE_KEY;

/**
 * 기본 아이템을 고정 id로 upsert한다. $setOnInsert만 써서 "없을 때만" 넣고, 이미 있는 아이템(가격 · 구매 수 등)은 건드리지 않는다.
 * timestamps: false로 Mongoose가 updatedAt을 $set하지 못하게 막고, createdAt · updatedAt은 $setOnInsert에 직접 넣는다.
 * createdAt은 목록 순서(최신순)가 앱 목록 순서와 같도록 앞 아이템일수록 1ms 늦게 한다.
 * 새로 넣은 개수를 돌려준다. 실패하면 예외를 던진다(서버 시작에서는 ShopSeedService가 잡아서 로그만 남긴다)
 */
export async function seedShopItems(model: Model<ShopItem>): Promise<number> {
    const now = Date.now();
    let inserted = 0;
    for (const [index, { id, ...fields }] of SHOP_SEED_ITEMS.entries()) {
        const at = new Date(now - index);
        try {
            const result = await model.updateOne(
                { _id: new Types.ObjectId(id) },
                { $setOnInsert: { ...fields, createdAt: at, updatedAt: at } },
                { upsert: true, timestamps: false },
            );
            if (result.upsertedCount > 0) inserted += 1;
        } catch (e) {
            if (!isDuplicateKey(e)) throw e;
        }
    }
    return inserted;
}

/** 서버 시작 때 쓰는 진입점: 끄기 설정이면 건너뛰고, 실패해도 예외를 밖으로 내지 않는다 */
export async function runShopSeed(
    model: Model<ShopItem>,
    env: string | undefined,
    logger: Pick<Logger, 'log' | 'error'> = new Logger('ShopSeed'),
): Promise<void> {
    if (!isShopSeedEnabled(env)) {
        logger.log(`${SHOP_SEED_ENV}=off 라서 기본 상점 아이템을 넣지 않습니다.`);
        return;
    }
    try {
        const inserted = await seedShopItems(model);
        logger.log(`기본 상점 아이템 확인 완료 (새로 넣은 개수: ${inserted}/${SHOP_SEED_ITEMS.length})`);
    } catch (e) {
        logger.error(`기본 상점 아이템을 넣지 못했습니다(서버는 계속 시작합니다): ${String(e)}`);
    }
}
