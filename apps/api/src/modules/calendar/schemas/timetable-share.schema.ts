import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TimetableShareDocument = HydratedDocument<TimetableShare>;

@Schema({ collection: 'timetable_shares', timestamps: { createdAt: false, updatedAt: false } })
export class TimetableShare {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // 시간표 주인[cite: 27]

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  friendId: Types.ObjectId; // 공유받을 친구[cite: 27]

  @Prop({ required: true })
  mode: string; // full(전체 공개), free_only(빈 시간만 공개) 등[cite: 27]

  @Prop({ required: true, default: Date.now })
  sharedAt: Date;
}

export const TimetableShareSchema = SchemaFactory.createForClass(TimetableShare);
