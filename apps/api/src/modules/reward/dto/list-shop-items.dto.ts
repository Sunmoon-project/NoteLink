import { IsIn, IsOptional } from 'class-validator';

import { SHOP_CATEGORIES, type ShopCategory } from '../schemas/shop-item.schema.js';

export const SHOP_SORTS = ['latest', 'price', 'popular'] as const;
export type ShopSort = (typeof SHOP_SORTS)[number];

/** GET /shop/items?category=avatar&sort=price 의 쿼리 */
export class ListShopItemsDto {
    @IsOptional()
    @IsIn(SHOP_CATEGORIES)
    category?: ShopCategory;

    @IsOptional()
    @IsIn(SHOP_SORTS)
    sort?: ShopSort;
}