import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

import { REVIEW_REMIND_TTL_SECONDS } from './review-remind.js';

export type ReviewReminderDocument = HydratedDocument<ReviewReminder>;

/**
 * 복습 알림(FR-37-08)을 사용자 · 날짜마다 한 번만 보내려는 표시. users · quiz_sets 스키마는 건드리지 않고 따로 둔다.
 * (userId, day) 유니크 색인이 서버가 여러 대여도 한 사용자에게 하루 한 번만 선점되게 한다(ReviewRemindersService)
 */
@Schema({ collection: 'review_reminders', timestamps: false })
export class ReviewReminder {
  @Prop({ type: Types.ObjectId, required: true })
  userId!: Types.ObjectId;

  /** 서울 날짜 YYYY-MM-DD */
  @Prop({ type: String, required: true })
  day!: string;

  /** null(대기) / claimed(선점) / sent / skipped(보내지 않고 끝) / gave_up(발송 실패로 포기) */
  @Prop({ type: String, enum: ['claimed', 'sent', 'skipped', 'gave_up'], default: null })
  state?: string | null;

  @Prop({ type: String })
  claimId?: string;

  @Prop({ type: Date })
  claimedAt?: Date;

  @Prop({ type: Number, default: 0 })
  attempts?: number;

  /** 발송에 실패한 뒤 다시 시도할 시각 */
  @Prop({ type: Date, default: null })
  retryAt?: Date | null;

  /** 만든 시각(TTL 색인) */
  @Prop({ type: Date, required: true })
  createdAt!: Date;
}

export const ReviewReminderSchema = SchemaFactory.createForClass(ReviewReminder);

// 사용자마다 하루 한 번
ReviewReminderSchema.index({ userId: 1, day: 1 }, { unique: true });
// 한도에 닿은 만료된 선점 정리 · 그날 끝난 사용자 읽기
ReviewReminderSchema.index({ day: 1, state: 1 });
// 지난 표시는 지운다
ReviewReminderSchema.index({ createdAt: 1 }, { expireAfterSeconds: REVIEW_REMIND_TTL_SECONDS });
