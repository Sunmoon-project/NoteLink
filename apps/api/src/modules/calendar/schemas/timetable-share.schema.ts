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
}

export const TimetableShareSchema = SchemaFactory.createForClass(TimetableShare);
TimetableShareSchema.index({ ownerId: 1, friendId: 1 }, { unique: true }); // 친구 한 명당 공유 한 건
