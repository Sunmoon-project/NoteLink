import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RecurringGoalDocument = HydratedDocument<RecurringGoal>;

@Schema({ collection: 'recurring_goals', timestamps: true })
export class RecurringGoal {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String })
  name: string; // 예: 매일 30분 영어 단어 암기

  // 공용 계약 number[]: 0(일) ~ 6(토)
  @Prop({
    type: [Number],
    required: true,
    validate: {
      validator: (v: number[]) => v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      message: 'days는 0~6 정수 배열이어야 합니다.',
    },
  })
  days: number[];

  @Prop({ required: true, type: Number })
  targetMin: number; // 목표 시간(분)

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  subjectId?: Types.ObjectId;

  @Prop({ required: true, type: Boolean, default: false })
  remindEnabled: boolean;

  @Prop({ type: String, default: null })
  remindTime?: string; // 예: "20:00"

  @Prop({ type: Date, default: null })
  pausedUntil?: Date;

  @Prop({ required: true, type: Number, default: 0 })
  streak: number; // 연속 달성 일수

  @Prop({ required: true, type: Boolean, default: true })
  isActive: boolean;

  // 소프트 삭제(FR-11-10): 지운 시각. null이면 살아 있는 목표. 문서는 지우지 않아 과거 기록이 남는다
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const RecurringGoalSchema = SchemaFactory.createForClass(RecurringGoal);

// 내 살아 있는 목표를 만든 순서로 읽는다
RecurringGoalSchema.index({ userId: 1, deletedAt: 1, createdAt: 1 });
