import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PointLedgerDocument = HydratedDocument<PointLedger>;

// updatedAt은 필요 없으므로 createdAt만 자동 기록합니다[cite: 25].
@Schema({ collection: 'point_ledger', timestamps: { createdAt: true, updatedAt: false } })
export class PointLedger {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  amount: number; // 양수(+): 적립, 음수(-): 차감[cite: 25]

  @Prop({ required: true })
  balanceAfter: number; // 거래 후 잔액[cite: 25]

  @Prop({ required: true })
  reasonType: string; // shop_buy, study_session, quiz_reward 등[cite: 25]

  // 연관된 대상 ID들 (선택적 참조)[cite: 25]
  @Prop({ type: Types.ObjectId, ref: 'ShopItem' })
  itemId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'QuizAttempt' })
  attemptId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'StudySession' })
  sessionId?: Types.ObjectId;

  @Prop()
  studyDate?: string;

  @Prop()
  description?: string;
}

export const PointLedgerSchema = SchemaFactory.createForClass(PointLedger);
