import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FriendshipDocument = HydratedDocument<Friendship>;

@Schema({ collection: 'friendships', timestamps: false })
export class Friendship {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userA: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userB: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  requesterId: Types.ObjectId; // 요청을 보낸 사람

  @Prop({ required: true, type: String, default: 'pending' })
  status: string; // pending, accepted, rejected, blocked

  @Prop({ required: true, type: Date, default: Date.now })
  requestedAt: Date;

  @Prop({ type: Date, default: null })
  acceptedAt?: Date | null;
}

export const FriendshipSchema = SchemaFactory.createForClass(Friendship);
