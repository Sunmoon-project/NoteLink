import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ShopItem } from '../schemas/shop-item.schema.js';
import { runShopSeed } from './shop-seed.js';

/** 서버가 시작될 때 상점 기본 아이템을 한 번 확인해 없는 것만 넣는다 (SHOP_SEED=off면 건너뜀) */
@Injectable()
export class ShopSeedService implements OnApplicationBootstrap {
    constructor(@InjectModel(ShopItem.name) private readonly shopItemModel: Model<ShopItem>) {}

    onApplicationBootstrap(): Promise<void> {
        return runShopSeed(this.shopItemModel, process.env.SHOP_SEED);
    }
}
