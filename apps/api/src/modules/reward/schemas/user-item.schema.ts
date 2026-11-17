import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, type HydratedDocument } from 'mongoose';

import { SHOP_CATEGORIES, type ShopCategory } from './shop-item.schema.js';

export type UserItemDocument = HydratedDocument<UserItem>;

// 사용자 한 명과 아이템 하나의 관계 (보유·찜·장착)
// 찜만 해도 행이 생기고, 구매하면 isOwned가 true가 된다
@Schema({ collection: 'user_items', timestamps: true })
export class UserItem {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    userId: Types.ObjectId; // users 참조

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ShopItem', required: true })
    itemId: Types.ObjectId; // shop_items 참조

    @Prop({ type: String, required: true, enum: SHOP_CATEGORIES })
    itemCategory: ShopCategory; // 장착할 때 "같은 종류끼리" 바꾸려고 복사해 둠

    @Prop({ required: true, default: false })
    isOwned: boolean;

    @Prop({ required: true, default: false })
    isWished: boolean;

    @Prop({ required: true, default: false })
    isEquipped: boolean;

    @Prop({ type: Date, default: null })
    wishedAt?: Date | null; // 찜한 시각

    @Prop({ type: Date, default: null })
    acquiredAt: Date | null; // 구매한 시각

    @Prop({ type: String, default: null })
    acquiredType?: string | null; // purchase, event 등
}

export const UserItemSchema = SchemaFactory.createForClass(UserItem);

// 한 사람이 같은 아이템 행을 두 개 가질 수 없게 (조회도 빨라짐)
UserItemSchema.index({ userId: 1, itemId: 1 }, { unique: true });
// 같은 종류(아바타·테마)에서 장착 중인 아이템은 한 사람당 1개만. 동시에 장착 요청이 와도 DB가 막아 준다
UserItemSchema.index(
    { userId: 1, itemCategory: 1 },
    { unique: true, partialFilterExpression: { isEquipped: true } },
);
