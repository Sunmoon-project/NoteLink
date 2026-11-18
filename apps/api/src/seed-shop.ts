import 'reflect-metadata';

import mongoose from 'mongoose';

import { ShopItem, ShopItemSchema } from './modules/reward/schemas/shop-item.schema.js';
import { SHOP_SEED_ITEMS, seedShopItems } from './modules/reward/shop/shop-seed.js';

/** 서버를 띄우지 않고 상점 기본 아이템을 넣는다 (npm run seed:shop -w @notelink/api, 먼저 build). 서버 시작 때와 같은 seedShopItems를 쓴다 */
async function main(): Promise<void> {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI가 비어 있습니다 (apps/api/.env 확인)');
    await mongoose.connect(uri);
    try {
        const model = mongoose.model(ShopItem.name, ShopItemSchema);
        const inserted = await seedShopItems(model);
        process.stdout.write(`기본 상점 아이템 확인 완료 (새로 넣은 개수: ${inserted}/${SHOP_SEED_ITEMS.length})
`);
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
});
