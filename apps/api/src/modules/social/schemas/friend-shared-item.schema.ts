import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FriendSharedItemDocument = HydratedDocument<FriendSharedItem>;

/**
 * 친구에게 보낸 노트 하나(#554). 받은 사람은 원본을 읽기만 하고(ownerOfShared), 「내 노트로 복사」로 사본을 만들 수 있다.
 * 보낸 사람이 철회하면 revokedAt, 친구를 끊으면 그 관계(friendshipId)로 만든 줄을 지운다(시간표 공유 FR-15-06과 같다).
 * 읽을 때도 friendshipId 관계가 아직 수락 상태인지 본다: 끊었다 다시 친구가 되면 관계 문서가 새로 생겨 옛 공유는 살아나지 않는다
 */
@Schema({ collection: 'friend_shared_items', timestamps: { createdAt: true, updatedAt: false } })
export class FriendSharedItem {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // 보낸 사람(노트 주인)

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  friendId: Types.ObjectId; // 받은 친구

  @Prop({ type: Types.ObjectId, ref: 'Material', required: true })
  materialId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Friendship', required: true })
  friendshipId: Types.ObjectId;

  @Prop({ type: Date, default: null })
  revokedAt?: Date | null;
}

export const FriendSharedItemSchema = SchemaFactory.createForClass(FriendSharedItem);
// 같은 관계에서 같은 노트는 살아 있는 공유 하나(동시에 보내도 DB가 막는다). 철회한 뒤 다시 보내면 새 공유다
FriendSharedItemSchema.index(
  { ownerId: 1, friendId: 1, materialId: 1, friendshipId: 1 },
  { name: 'friend_share_unique', unique: true, partialFilterExpression: { revokedAt: null } },
);
// 받은 사람의 읽기 확인(노트 → 나에게 온 공유)
FriendSharedItemSchema.index({ materialId: 1, friendId: 1 });
// 친구 끊기 정리
FriendSharedItemSchema.index({ friendshipId: 1 });
