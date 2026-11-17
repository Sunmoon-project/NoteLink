import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { TokenService } from '../src/modules/auth/token.service.js';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';

import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { PointController } from '../src/modules/reward/point/point.controller.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger } from '../src/modules/reward/schemas/point-ledger.schema.js';
import { ShopItem } from '../src/modules/reward/schemas/shop-item.schema.js';
import { UserItem } from '../src/modules/reward/schemas/user-item.schema.js';
import { PurchaseController } from '../src/modules/reward/shop/purchase.controller.js';
import { ShopController } from '../src/modules/reward/shop/shop.controller.js';
import { ShopService } from '../src/modules/reward/shop/shop.service.js';
import { MyItemsController } from '../src/modules/reward/shop/my-items.controller.js';

export const TEST_USER_ID = new Types.ObjectId().toString();
const TEST_TOKEN = 'test-token';
/** 로그인한 요청에 붙이는 헤더 */
export const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };

/** 진짜 DB 대신 가짜 모델을 넣은 상점·포인트 테스트용 서버 */
export async function createShopTestApp(models: {
    shopItem: object;
    userItem: object;
    pointLedger?: object; // 포인트 내역·구매 테스트에서만 넘긴다
    user?: object; // 구매 테스트에서만 넘긴다 (포인트 잔액)
    connection?: object; // 구매 테스트에서만 넘긴다 (트랜잭션)
}): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
        controllers: [ShopController, MyItemsController, PurchaseController, PointController],
        providers: [
            ShopService,
            PointService,
            { provide: getModelToken(ShopItem.name), useValue: models.shopItem },
            { provide: getModelToken(UserItem.name), useValue: models.userItem },
            { provide: getModelToken(PointLedger.name), useValue: models.pointLedger ?? {} },
            { provide: getModelToken(User.name), useValue: models.user ?? {} },
            { provide: getConnectionToken(), useValue: models.connection ?? {} },
            // 로그인 확인(JwtAuthGuard)이 쓰는 도구의 가짜: TEST_TOKEN만 통과시킨다
            {
                provide: TokenService,
                useValue: {
                    verifyAccess: (token: string) =>
                        token === TEST_TOKEN
                            ? Promise.resolve({ userId: TEST_USER_ID })
                            : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                },
            },
        ],
    }).compile();

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return app;
}