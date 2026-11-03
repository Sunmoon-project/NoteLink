import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuthCodeDocument = HydratedDocument<AuthCode>;

@Schema({ collection: 'auth_codes', timestamps: true })
export class AuthCode {
  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  purpose: string;

  @Prop({ required: true })
  codeHash: string;

  @Prop({ required: true, default: 0 })
  attempts: number; // DB 명세의 int 타입

  @Prop({ required: true })
  expiresAt: Date; // DB 명세의 date 타입
}

export const AuthCodeSchema = SchemaFactory.createForClass(AuthCode);
