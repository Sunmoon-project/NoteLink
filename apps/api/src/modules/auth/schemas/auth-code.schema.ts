// apps/api/src/modules/auth/schemas/auth-code.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuthCodeDocument = HydratedDocument<AuthCode>;

@Schema({ collection: 'auth_codes', timestamps: true })
export class AuthCode {
  @Prop({ required: true, type: String })
  email: string;

  @Prop({ required: true, type: String })
  purpose: string;

  @Prop({ required: true, type: String})
  codeHash: string;

  @Prop({ required: true, type: Number, default: 0 })
  attempts: number; // DB 명세의 int 타입

  @Prop({ required: true, type: Date })
  expiresAt: Date; // DB 명세의 date 타입
}

export const AuthCodeSchema = SchemaFactory.createForClass(AuthCode);
