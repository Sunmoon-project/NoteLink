import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const SHARE_MODES = ['full', 'free_only'] as const; // 전체 공개 / 비는 시간만
export type ShareMode = (typeof SHARE_MODES)[number];

export type TimetableShareDocument = HydratedDocument<TimetableShare>;

@Schema({ collection: 'timetable_shares', timestamps: { createdAt: false, updatedAt: false } })
export class TimetableShare {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // 시간표 주인

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  friendId: Types.ObjectId; // 공유받을 친구

  @Prop({ required: true, type: String, enum: SHARE_MODES })
  mode: ShareMode; // full(전체 공개), free_only(빈 시간만 공개)

  @Prop({ required: true, type: Date, default: Date.now })
  sharedAt: Date;

  /**
   * 이 공유를 만든 친구 관계(friendships 문서 id). 친구를 끊었다 다시 맺으면 관계 문서가 새로 생겨 id가 달라지므로,
   * 끊긴 관계의 공유만 정리하고 다시 친구가 된 뒤의 새 공유는 남길 수 있다. 예전 공유는 값이 없다(null)
   */
  @Prop({ type: Types.ObjectId, ref: 'Friendship', default: null })
  friendshipId?: Types.ObjectId | null;
}

export const TimetableShareSchema = SchemaFactory.createForClass(TimetableShare);
TimetableShareSchema.index({ ownerId: 1, friendId: 1 }, { unique: true }); // 친구 한 명당 공유 한 건
