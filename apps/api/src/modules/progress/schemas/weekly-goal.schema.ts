import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type WeeklyGoalDocument = HydratedDocument<WeeklyGoal>;

@Schema({ collection: 'weekly_goals', timestamps: true })
export class WeeklyGoal {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  weekStart: string; // 해당 주의 월요일 날짜 (YYYY-MM-DD)[cite: 26]

  @Prop({ required: true })
  targetMin: number; // 이번 주 목표 시간(분)[cite: 26]

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  subjectId?: Types.ObjectId;

  @Prop({ required: true, default: false })
  notify80: boolean; // 80% 달성 시 알림 여부[cite: 26]
}

export const WeeklyGoalSchema = SchemaFactory.createForClass(WeeklyGoal);
