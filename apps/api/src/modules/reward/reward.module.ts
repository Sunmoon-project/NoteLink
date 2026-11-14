import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';


import { AuthModule } from '../auth/auth.module.js';
import { ShopItem, ShopItemSchema } from './schemas/shop-item.schema.js';
import { UserItem, UserItemSchema } from './schemas/user-item.schema.js';
import { ShopController } from './shop/shop.controller.js';
import { ShopService } from './shop/shop.service.js';
import { ShopSeedService } from './shop/shop-seed.service.js';
import { MyItemsController } from './shop/my-items.controller.js';
import { PurchaseController } from './shop/purchase.controller.js';
import { PointController } from './point/point.controller.js';
import { PointService } from './point/point.service.js';
import { PointLedger, PointLedgerSchema } from './schemas/point-ledger.schema.js';
import { User, UserSchema } from '../auth/schemas/user.schema.js';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: ShopItem.name, schema: ShopItemSchema },
            { name: UserItem.name, schema: UserItemSchema },
            { name: PointLedger.name, schema: PointLedgerSchema }, 
            { name: User.name, schema: UserSchema },
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [ShopController, MyItemsController, PurchaseController, PointController],
    providers: [ShopService, ShopSeedService, PointService],
    exports: [PointService], // 세션·퀴즈 모듈이 적립을 부를 수 있게
})
export class RewardModule { }