// 진짜 MongoDB에서 상점 시드가 빈 DB에 6개를 넣고, 반복 · 동시에 돌려도 6개이며, 바꿔 둔 값을 덮어쓰지 않는지 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 파일 고유 DB(notelink_verify_shop_seed_<pid>_<시각>)만 쓰고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/shop-seed-real-db.test.ts
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { createConnection, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { ShopItem, ShopItemSchema } from '../src/modules/reward/schemas/shop-item.schema.js';
import { UserItem, UserItemSchema } from '../src/modules/reward/schemas/user-item.schema.js';
import { ShopSeedService } from '../src/modules/reward/shop/shop-seed.service.js';
import { SHOP_SEED_ENV, SHOP_SEED_ITEMS, seedShopItems } from '../src/modules/reward/shop/shop-seed.js';
import { ShopController } from '../src/modules/reward/shop/shop.controller.js';
import { ShopService } from '../src/modules/reward/shop/shop.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_shop_seed_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 상점 시드 확인', () => {
    let app: INestApplication;
    let conn: Connection;
    let model: Model<ShopItem>;

    const items = () => conn.collection('shop_items');
    const count = () => items().countDocuments();

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: ShopItem.name, schema: ShopItemSchema },
                    { name: UserItem.name, schema: UserItemSchema },
                ]),
            ],
            controllers: [ShopController],
            providers: [
                ShopService,
                { provide: PointService, useValue: {} },
                { provide: TokenService, useValue: {} }, // 목록 조회는 로그인이 필요 없다
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        model = moduleRef.get<Model<ShopItem>>(getModelToken(ShopItem.name));
    });

    afterAll(async () => {
        if (conn && isLocal) await conn.dropDatabase();
        await app?.close();
    });

    it('빈 DB에 시드하면 상점 목록에 6개가 나온다', async () => {
        expect(await count()).toBe(0);
        await expect(seedShopItems(model)).resolves.toBe(6);
        const res = await request(app.getHttpServer()).get('/api/v1/shop/items');
        expect(res.status).toBe(200);
        expect(res.body.data.map((i: { name: string }) => i.name)).toEqual(SHOP_SEED_ITEMS.map((i) => i.name));
        expect(res.body.data.map((i: { _id: string }) => i._id)).toEqual(SHOP_SEED_ITEMS.map((i) => i.id));
    });

    it('두 번 · 동시에 돌려도 6개 그대로다', async () => {
        await expect(seedShopItems(model)).resolves.toBe(0);
        await Promise.all([seedShopItems(model), seedShopItems(model), seedShopItems(model)]);
        expect(await count()).toBe(6);
    });

    it('빈 DB에서 동시에 처음 돌려도 6개다', async () => {
        await items().deleteMany({});
        await Promise.all([seedShopItems(model), seedShopItems(model), seedShopItems(model)]);
        expect(await count()).toBe(6);
    });

    it('바꿔 둔 가격 · 구매 수 · 판매 중지는 시드 후에도 그대로다', async () => {
        await items().updateOne({ name: '새벽 아바타' }, { $set: { price: 777, purchaseCount: 42, isActive: false } });
        const before = await items().findOne({ name: '새벽 아바타' });
        await seedShopItems(model);
        const after = await items().findOne({ name: '새벽 아바타' });
        expect(String(after!._id)).toBe(SHOP_SEED_ITEMS[0]!.id);
        expect(after).toMatchObject({ price: 777, purchaseCount: 42, isActive: false });
        expect(after!.updatedAt).toEqual(before!.updatedAt);
        expect(await count()).toBe(6);
    });
});

// 서버가 켜질 때(app.init → ShopSeedService.onApplicationBootstrap) 자동으로 시드가 도는지. seedShopItems를 직접 부르지 않는다
describe.skipIf(!uri)('진짜 DB 서버 시작 시 상점 시드 자동 실행', () => {
    const originalSeedEnv = process.env[SHOP_SEED_ENV];
    const opened: INestApplication[] = [];
    let admin: Connection; // 앱과 따로 연결해 두고 DB를 읽고 비운다

    /** ShopSeedService가 등록된 앱을 만들고 app.init()만 한다(시드는 init 안에서 자동으로 돈다) */
    const boot = async (beforeInit?: (model: Model<ShopItem>) => void) => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([{ name: ShopItem.name, schema: ShopItemSchema }]),
            ],
            providers: [ShopSeedService],
        }).compile();
        const app = moduleRef.createNestApplication();
        opened.push(app);
        beforeInit?.(moduleRef.get<Model<ShopItem>>(getModelToken(ShopItem.name)));
        await app.init();
        return app;
    };
    const items = () => admin.collection('shop_items');

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        admin = await createConnection(uri!, { dbName, serverSelectionTimeoutMS: 5000 }).asPromise();
    });

    afterEach(async () => {
        // 환경 변수를 원래대로 돌리고, 다음 테스트가 빈 DB에서 시작하게 한다
        if (originalSeedEnv === undefined) delete process.env[SHOP_SEED_ENV];
        else process.env[SHOP_SEED_ENV] = originalSeedEnv;
        vi.restoreAllMocks();
        await Promise.all(opened.splice(0).map((app) => app.close()));
        await items().deleteMany({});
    });

    afterAll(async () => {
        if (admin) {
            if (isLocal) await admin.dropDatabase();
            await admin.close();
        }
    });

    it('빈 DB에서 app.init()만 해도 상점 아이템 6개가 들어간다', async () => {
        delete process.env[SHOP_SEED_ENV];
        expect(await items().countDocuments()).toBe(0);
        await boot();
        expect(await items().countDocuments()).toBe(6);
        const names = (await items().find({}).sort({ createdAt: -1 }).toArray()).map((d) => d['name']);
        expect(names).toEqual(SHOP_SEED_ITEMS.map((i) => i.name));
    });

    it('SHOP_SEED=off면 app.init()을 해도 shop_items에 아무것도 쓰지 않는다', async () => {
        process.env[SHOP_SEED_ENV] = 'off';
        await boot();
        expect(await items().countDocuments()).toBe(0);
    });

    it('시드 쓰기가 실패해도 app.init()은 성공하고, 다음에 켜면 채워진다', async () => {
        delete process.env[SHOP_SEED_ENV];
        const updateOne = vi.fn().mockRejectedValue(new Error('db down'));
        await expect(boot((model) => void vi.spyOn(model, 'updateOne').mockImplementation(updateOne))).resolves.toBeDefined();
        expect(updateOne).toHaveBeenCalled();
        expect(await items().countDocuments()).toBe(0);

        vi.restoreAllMocks();
        await boot();
        expect(await items().countDocuments()).toBe(6);
    });
});
