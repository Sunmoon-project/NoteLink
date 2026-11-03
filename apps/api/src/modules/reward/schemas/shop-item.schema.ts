import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShopItemDocument = HydratedDocument<ShopItem>;

@Schema({ collection: 'shop_items', timestamps: true })
export class ShopItem {
  @Prop({ required: true })
  category: string; // avatar, theme 등

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ required: true, default: 0 })
  price: number; // 포인트 가격

  @Prop()
  avatarStyle?: string;

  @Prop()
  thumbnailUrl?: string;

  @Prop({ required: true })
  assetUrl: string;

  @Prop({ required: true, default: 0 })
  purchaseCount: number;

  @Prop({ required: true, default: true })
  isActive: boolean;

  @Prop({ required: true, default: false })
  isDefault: boolean;
}

export const ShopItemSchema = SchemaFactory.createForClass(ShopItem);
