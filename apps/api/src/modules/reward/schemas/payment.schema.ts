import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PaymentDocument = HydratedDocument<Payment>;

@Schema({ collection: 'payments', timestamps: true })
export class Payment {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  purpose: string; // subscription 등[cite: 25]

  @Prop()
  planTier?: string; // pro, max 등[cite: 25]

  @Prop()
  periodEnd?: Date;

  @Prop({ required: true })
  amountKrw: number; // 실제 결제 원화 금액[cite: 25]

  @Prop({ required: true, default: 'pending' })
  status: string; // pending, paid, failed, canceled[cite: 25]

  @Prop()
  pgTransactionId?: string; // PG사 승인 번호[cite: 25]

  @Prop()
  failedReason?: string;

  @Prop()
  paidAt?: Date;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);
