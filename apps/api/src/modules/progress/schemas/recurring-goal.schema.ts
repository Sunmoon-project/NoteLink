import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RecurringGoalDocument = HydratedDocument<RecurringGoal>;

@Schema({ collection: 'recurring_goals', timestamps: true })
export class RecurringGoal {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  name: string; // 예: 매일 30분 영어 단어 암기[cite: 26]

  @Prop({ required: true })
  days: number; // 목표 요일 비트마스크[cite: 26]

  @Prop({ required: true })
  targetMin: number; // 목표 시간(분)[cite: 26]

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  subjectId?: Types.ObjectId;

  @Prop({ required: true, default: false })
  remindEnabled: boolean;

  @Prop()
  remindTime?: string; // 예: "20:00"[cite: 26]

  @Prop()
  pausedUntil?: Date;

  @Prop({ required: true, default: 0 })
  streak: number; // 연속 달성 일수[cite: 26]

  @Prop({ required: true, default: true })
  isActive: boolean;
}

export const RecurringGoalSchema = SchemaFactory.createForClass(RecurringGoal);
