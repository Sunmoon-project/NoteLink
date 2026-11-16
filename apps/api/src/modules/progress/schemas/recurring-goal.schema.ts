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
  remindTime?: string; // 예: "21:00". 만들 때 안 보내면 서비스가 기본 "21:00"을 넣는다

  @Prop({ type: Date, default: null })
  pausedUntil?: Date;

  // 리마인드 푸시(FR-11-07): 오늘(서울 날짜) 이미 보냈거나 처리한 날. 서버가 여럿이어도 { lastRemindedOn: { $ne: 오늘 } } 조건부 갱신으로 한 곳만 잡는다
  @Prop({ type: String, default: null })
  lastRemindedOn?: string | null;

  // 발송 실패 뒤 다시 시도하는 정보: 시도한 날(서울) · 그날 시도 횟수 · 다음 시도 가능 시각 · 지금 잡은 서버의 표시
  @Prop({ type: String, default: null })
  remindAttemptsOn?: string | null;

  @Prop({ type: Number, default: 0 })
  remindAttempts?: number;

  @Prop({ type: Date, default: null })
  remindRetryAt?: Date | null;

  @Prop({ type: String, default: null })
  remindClaimId?: string | null;

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
// 리마인드 후보(켠 목표 · 쉬지 않는 목표)만 요일 · 오늘 보냈는지로 빨리 찾는다
RecurringGoalSchema.index(
  { days: 1, lastRemindedOn: 1 },
  { partialFilterExpression: { remindEnabled: true, isActive: true } },
);
