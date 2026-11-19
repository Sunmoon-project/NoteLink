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
 * 상점 기본 아이템 11개(아바타 5 · 테마 1 · 치장 5). 앱의 기본 상품 목록(apps/mobile/src/lib/local/catalog.ts SHOP)과 같은 값이다.
 * 앱이 고정 id로 테마 색 · 치장 모양을 찾으므로 id(번호)는 바꾸지 않는다.
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
        description: '앱 바탕이 시원한 바다색으로 바뀌어요.',
        price: 1000,
        avatarStyle: null,
        thumbnailUrl: '🌊',
        assetUrl: '🌊',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
    {
        id: idOf(7),
        category: 'glasses',
        name: '동그란 안경',
        description: '책 읽는 선생님처럼 동그란 안경을 씌워요.',
        price: 300,
        avatarStyle: null,
        thumbnailUrl: '👓',
        assetUrl: '👓',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: 'NEW',
    },
    {
        id: idOf(8),
        category: 'glasses',
        name: '선글라스',
        description: '햇살 아래서도 멋진 까만 선글라스예요.',
        price: 300,
        avatarStyle: null,
        thumbnailUrl: '🕶️',
        assetUrl: '🕶️',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
    {
        id: idOf(9),
        category: 'hat',
        name: '털모자',
        description: '방울이 달린 포근한 털모자예요.',
        price: 400,
        avatarStyle: null,
        thumbnailUrl: '🧶',
        assetUrl: '🧶',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
    {
        id: idOf(10),
        category: 'hat',
        name: '학사모',
        description: '공부 끝판왕에게 어울리는 학사모예요.',
        price: 600,
        avatarStyle: null,
        thumbnailUrl: '🎓',
        assetUrl: '🎓',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
    {
        id: idOf(11),
        category: 'scarf',
        name: '빨간 목도리',
        description: '목을 따뜻하게 감싸는 빨간 목도리예요.',
        price: 400,
        avatarStyle: null,
        thumbnailUrl: '🧣',
        assetUrl: '🧣',
        purchaseCount: 0,
        isActive: true,
        isDefault: false,
        badge: null,
    },
];

/**
 * 이미 넣은 DB의 문구 고침. $setOnInsert는 기존 아이템을 건드리지 않으므로, 옛 문구 그대로일 때만 새 문구로 바꾼다
 * (운영자가 따로 고친 문구는 그대로 둔다). 바다 테마: 물결 그림 없이 바탕색만 바뀌므로 설명을 실제에 맞춘다
 */
const TEXT_FIXES = [
    {
        id: idOf(6),
        from: '시원한 파란 물결이 앱 전체를 감싸요.',
        to: '앱 바탕이 시원한 바다색으로 바뀌어요.',
    },
] as const;

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
    for (const { id, from, to } of TEXT_FIXES) {
        // 문구가 바뀌면 updatedAt도 새로(timestamps 기본값). _id 하나만 맞으므로 많아야 1건
        await model.updateMany({ _id: new Types.ObjectId(id), description: from }, { $set: { description: to } });
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
