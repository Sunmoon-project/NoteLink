import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UserItemDocument = HydratedDocument<UserItem>;

@Schema({ collection: 'user_items', timestamps: true })
export class UserItem {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId; // users 참조[cite: 25]

  @Prop({ type: Types.ObjectId, ref: 'ShopItem', required: true })
  itemId: Types.ObjectId; // shop_items 참조[cite: 25]

  @Prop({ required: true })
  itemCategory: string;

  @Prop({ required: true, default: false })
  isOwned: boolean;

  @Prop({ required: true, default: false })
  isWished: boolean;

  @Prop({ required: true, default: false })
  isEquipped: boolean; // 현재 장착 여부[cite: 25]

  @Prop()
  wishedAt?: Date;

  @Prop()
  acquiredAt?: Date;

  @Prop()
  acquiredType?: string; // purchase, event 등[cite: 25]
}

export const UserItemSchema = SchemaFactory.createForClass(UserItem);
