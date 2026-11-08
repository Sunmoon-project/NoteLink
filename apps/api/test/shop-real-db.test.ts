// 진짜 MongoDB(replica set)에서 구매·장착 트랜잭션이 되는지 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 전용 DB(notelink_verify_tmp)만 쓰고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/shop-real-db.test.ts
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { PointController } from '../src/modules/reward/point/point.controller.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger, PointLedgerSchema } from '../src/modules/reward/schemas/point-ledger.schema.js';
import { ShopItem, ShopItemSchema } from '../src/modules/reward/schemas/shop-item.schema.js';
import { UserItem, UserItemSchema } from '../src/modules/reward/schemas/user-item.schema.js';
import { MyItemsController } from '../src/modules/reward/shop/my-items.controller.js';
import { PurchaseController } from '../src/modules/reward/shop/purchase.controller.js';
import { ShopController } from '../src/modules/reward/shop/shop.controller.js';
import { ShopService } from '../src/modules/reward/shop/shop.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);

describe.skipIf(!uri)('진짜 DB 구매·장착 확인', () => {
    const userId = new Types.ObjectId();
    const TOKEN = 'verify-token';
    const AUTH = { Authorization: `Bearer ${TOKEN}` };
    let app: INestApplication;
    let conn: Connection;
    const col = (name: string) => conn.collection(name);

    const itemA = new Types.ObjectId(); // 700P
    const itemB = new Types.ObjectId(); // 800P
    const itemC = new Types.ObjectId(); // 200P
    const itemD = new Types.ObjectId(); // 200P
    const themeE = new Types.ObjectId();

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName: 'notelink_verify_tmp', serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: ShopItem.name, schema: ShopItemSchema },
                    { name: UserItem.name, schema: UserItemSchema },
                    { name: PointLedger.name, schema: PointLedgerSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [ShopController, MyItemsController, PurchaseController, PointController],
            providers: [
                ShopService,
                PointService,
                {
                    provide: TokenService,
                    useValue: {
                        verifyAccess: (t: string) =>
                            t === TOKEN
                                ? Promise.resolve({ userId: userId.toString() })
                                : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                    },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        await Promise.all([
            conn.model(ShopItem.name).init(),
            conn.model(UserItem.name).init(),
            conn.model(PointLedger.name).init(),
        ]);
        await col('users').insertOne({ _id: userId, pointBalance: 1000 });
        const mk = (_id: Types.ObjectId, name: string, price: number) => ({
            _id, category: 'avatar', name, price, assetUrl: 'x', purchaseCount: 0,
            isActive: true, isDefault: false, badge: null, createdAt: new Date(), updatedAt: new Date(),
        });
        await col('shop_items').insertMany([mk(itemA, 'A', 700), mk(itemB, 'B', 800), mk(itemC, 'C', 200), mk(itemD, 'D', 200)]);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    const buy = (itemId: Types.ObjectId) =>
        request(app.getHttpServer()).post('/api/v1/shop/purchases').set(AUTH).send({ itemId: itemId.toString() });
    const balance = async () =>
        ((await col('users').findOne({ _id: userId })) as unknown as { pointBalance: number }).pointBalance;

    it('1) 구매하면 잔액·장부·보유·구매수가 함께 바뀐다', async () => {
        const res = await buy(itemA);
        expect(res.status).toBe(201);
        expect(res.body).toEqual({ data: { balance: 300 } });
        expect(await balance()).toBe(300);
        const ledger = await col('point_ledgers').find({ userId }).toArray();
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ amount: -700, balanceAfter: 300, reasonType: 'purchase' });
        expect(await col('user_items').findOne({ userId, itemId: itemA })).toMatchObject({ isOwned: true });
        expect(await col('shop_items').findOne({ _id: itemA })).toMatchObject({ purchaseCount: 1 });
    });

    it('2) 같은 아이템을 또 사면 409이고 아무것도 바뀌지 않는다', async () => {
        const res = await buy(itemA);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ITEM_ALREADY_OWNED');
        expect(await balance()).toBe(300);
        expect(await col('point_ledgers').countDocuments({ userId })).toBe(1);
    });

    it('3) 포인트가 모자라면 400이고 중간에 쓴 기록이 전부 취소된다 (롤백)', async () => {
        const res = await buy(itemB);
        expect(res.status).toBe(400);
        expect(await balance()).toBe(300);
        expect(await col('point_ledgers').countDocuments({ userId })).toBe(1);
        expect(await col('user_items').countDocuments({ userId, itemId: itemB })).toBe(0);
        expect(await col('shop_items').findOne({ _id: itemB })).toMatchObject({ purchaseCount: 0 });
    });

    it('4) 거의 동시에 둘을 사도 잔액이 마이너스가 되지 않는다 (300P로 200P짜리 2개)', async () => {
        const [r1, r2] = await Promise.all([buy(itemC), buy(itemD)]);
        const statuses = [r1.status, r2.status].sort();
        expect(await balance()).toBeGreaterThanOrEqual(0);
        const owned = await col('user_items').countDocuments({ userId, itemId: { $in: [itemC, itemD] }, isOwned: true });
        expect(owned).toBe(statuses.filter((s) => s === 201).length);
        expect(owned).toBe(1);
        expect(await balance()).toBe(100);
    });

    it('5) 같은 종류를 거의 동시에 장착해도 장착은 항상 1개다 (아바타 C·D 여러 번 반복)', async () => {
        const row = (itemId: Types.ObjectId, itemCategory: string) => ({
            userId, itemId, itemCategory, isOwned: true, isWished: false, isEquipped: false, acquiredAt: new Date(),
        });
        await col('user_items').deleteMany({ userId, itemId: { $in: [itemC, itemD] } });
        await col('user_items').insertMany([row(itemC, 'avatar'), row(itemD, 'avatar'), row(themeE, 'theme')]);
        const equip = (id: Types.ObjectId) =>
            request(app.getHttpServer()).post(`/api/v1/users/me/items/${id.toString()}/equip`).set(AUTH);
        for (let round = 0; round < 10; round++) {
            const results = await Promise.all([equip(itemC), equip(itemD), equip(itemC), equip(itemD)]);
            expect(results.map((r) => r.status)).toEqual([204, 204, 204, 204]);
            const equipped = await col('user_items').countDocuments({ userId, itemCategory: 'avatar', isEquipped: true });
            expect(equipped).toBe(1);
        }
    });

    it('6) 아바타를 장착해도 테마 장착은 그대로다', async () => {
        const e = await request(app.getHttpServer()).post(`/api/v1/users/me/items/${themeE.toString()}/equip`).set(AUTH);
        expect(e.status).toBe(204);
        const a = await request(app.getHttpServer()).post(`/api/v1/users/me/items/${itemC.toString()}/equip`).set(AUTH);
        expect(a.status).toBe(204);
        expect(await col('user_items').countDocuments({ userId, itemCategory: 'theme', isEquipped: true })).toBe(1);
        expect(await col('user_items').countDocuments({ userId, itemCategory: 'avatar', isEquipped: true })).toBe(1);
    });
});
