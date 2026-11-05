import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShopItemDocument = HydratedDocument<ShopItem>;

@Schema({ collection: 'shop_items', timestamps: true })
export class ShopItem {
  @Prop({ required: true, type: String })
  category: string; // avatar, theme 등

  @Prop({ required: true, type: String })
  name: string;

  @Prop({ type: String, default: null})
  description?: string;

  @Prop({ required: true, default: 0 })
  price: number; // 포인트 가격

  @Prop({ type: String, default: null})
  avatarStyle?: string;

  @Prop({ type: String, default: null})
  thumbnailUrl?: string;

  @Prop({ required: true, type: String })
  assetUrl: string;

  @Prop({ required: true, default: 0 })
  purchaseCount: number;

  @Prop({ required: true, default: true })
  isActive: boolean;

  @Prop({ required: true, default: false })
  isDefault: boolean;
}

export const ShopItemSchema = SchemaFactory.createForClass(ShopItem);
