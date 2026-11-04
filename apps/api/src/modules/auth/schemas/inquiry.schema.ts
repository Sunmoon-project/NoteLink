import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type InquiryDocument = HydratedDocument<Inquiry>;

// inquiries: 사용자 문의(1:1 문의)
@Schema({ collection: 'inquiries', timestamps: true })
export class Inquiry {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  content: string;

  @Prop({ required: true, enum: ['open', 'answered', 'closed'], default: 'open' })
  status: string;

  @Prop({ default: null })
  answer?: string | null;

  @Prop({ default: null })
  answeredAt?: Date | null;
}

export const InquirySchema = SchemaFactory.createForClass(Inquiry);
