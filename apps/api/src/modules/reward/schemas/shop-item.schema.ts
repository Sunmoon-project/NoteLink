import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

// 정해진 값만 쓰도록 목록으로 둔다 (DTO 검사와 스키마가 같은 목록을 씀)
export const SHOP_CATEGORIES = ['avatar', 'theme'] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number];

export const SHOP_BADGES = ['NEW', 'BEST'] as const;
export type ShopBadge = (typeof SHOP_BADGES)[number];

export type ShopItemDocument = HydratedDocument<ShopItem>;

// 상점에서 파는 아이템 (공유 계약 ShopItem과 같은 필드)
// timestamps: createdAt이 자동으로 생겨서 "최신순" 정렬에 쓴다
@Schema({ collection: 'shop_items', timestamps: true })
export class ShopItem {
    @Prop({ type: String, required: true, enum: SHOP_CATEGORIES })
    category: ShopCategory;

    @Prop({ required: true })
    name: string;

    @Prop({ type: String, default: null })
    description: string | null;

    @Prop({ required: true, min: 0 })
    price: number;

    @Prop({ type: String, default: null })
    avatarStyle: string | null; // 아바타일 때만 씀

    @Prop({ type: String, default: null })
    thumbnailUrl: string | null;

    @Prop({ required: true })
    assetUrl: string;

    @Prop({ required: true, default: 0, min: 0 })
    purchaseCount: number; // 인기순 정렬 기준

    @Prop({ required: true, default: true })
    isActive: boolean; // false면 목록에서 숨김

    @Prop({ required: true, default: false })
    isDefault: boolean; // 가입 시 기본 지급 아이템

    @Prop({ type: String, enum: SHOP_BADGES, default: null })
    badge: ShopBadge | null;
}

export const ShopItemSchema = SchemaFactory.createForClass(ShopItem);

// 목록 조회(판매 중 + 카테고리 + 최신순)를 빠르게
ShopItemSchema.index({ isActive: 1, category: 1, createdAt: -1 });