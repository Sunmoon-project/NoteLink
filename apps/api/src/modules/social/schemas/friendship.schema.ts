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
// 한 쌍에 관계 문서 하나(userA는 id가 작은 쪽, FriendsService.pairOf). 동시에 서로 요청해도 두 개가 생기지 않는다
FriendshipSchema.index({ userA: 1, userB: 1 }, { unique: true });
// 받은 요청 · 친구 목록 조회
FriendshipSchema.index({ userB: 1, status: 1 });
