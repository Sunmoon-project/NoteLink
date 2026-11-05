import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 공용 스키마 PointLedger.reasonType
export const POINT_REASON_TYPES = [
  'session_complete',
  'quiz_correct',
  'review_complete',
  'session_abuse',
  'purchase',
  'mission',
  'admin',
] as const;

export type PointLedgerDocument = HydratedDocument<PointLedger>;

// updatedAt은 필요 없으므로 createdAt만 자동 기록합니다.
@Schema({ collection: 'point_ledgers', timestamps: { createdAt: true, updatedAt: false } })
export class PointLedger {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: Number })
  amount: number; // 양수(+): 적립, 음수(-): 차감

  @Prop({ required: true, type: Number })
  balanceAfter: number; // 거래 후 잔액

  @Prop({ required: true, type: String, enum: POINT_REASON_TYPES })
  reasonType: string; // 공용 스키마 reasonType 7종(POINT_REASON_TYPES)

  // 연관된 대상 ID들 (선택적 참조)
  @Prop({ type: Types.ObjectId, ref: 'ShopItem' })
  itemId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'QuizAttempt' })
  attemptId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'StudySession' })
  sessionId?: Types.ObjectId;

  @Prop({ type: String, default: null})
  studyDate?: string | null;

  @Prop({ type: String, default: null})
  description?: string | null;
}

export const PointLedgerSchema = SchemaFactory.createForClass(PointLedger);
