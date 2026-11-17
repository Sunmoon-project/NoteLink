import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type InquiryDocument = HydratedDocument<Inquiry>;

// inquiries: 사용자 문의(1:1 문의)
@Schema({ collection: 'inquiries', timestamps: true })
export class Inquiry {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String })
  title: string;

  @Prop({ required: true, type: String })
  content: string;

  @Prop({ required: true, type: String, enum: ['open', 'answered', 'closed'], default: 'open' })
  status: string;

  @Prop({ type: String, default: null })
  answer?: string | null;

  @Prop({ type: Date, default: null })
  answeredAt?: Date | null;
}

export const InquirySchema = SchemaFactory.createForClass(Inquiry);
