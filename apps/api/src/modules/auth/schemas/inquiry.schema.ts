import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AuthCodeDocument = AuthCode & Document;

@Schema({ timestamps: true, collection: 'inquiries' })
export class AuthCode {
  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  codeHash: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ default: false })
  isVerified: boolean;
}

export const AuthCodeSchema = SchemaFactory.createForClass(AuthCode);
