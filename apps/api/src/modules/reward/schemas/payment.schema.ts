import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PaymentDocument = HydratedDocument<Payment>;

@Schema({ collection: 'payments', timestamps: true })
export class Payment {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String })
  purpose: string; // subscription 등

  @Prop({ type: String, default: null })
  planTier?: string; // pro, max 등

  @Prop({ type: Date, default: null })
  periodEnd?: Date | null;

  @Prop({ required: true, type: Number })
  amountKrw: number; // 실제 결제 원화 금액

  @Prop({ required: true, default: 'pending' })
  status: string; // pending, paid, failed, canceled

  @Prop({ type: String, default: null })
  pgTransactionId?: string; // PG사 승인 번호

  @Prop({ type: String, default: null })
  failedReason?: string | null;

  @Prop({ type: Date, default: null })
  paidAt?: Date | null;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);
