// apps/api/src/modules/auth/schemas/refresh-token.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RefreshTokenDocument = RefreshToken & Document;

@Schema({ timestamps: true, collection: 'refresh_tokens' })
export class RefreshToken {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String, unique: true })
  tokenHash: string;

  @Prop({ type: Object })
  device?: Record<string, unknown>; // 발표자료 p.23: device object?

  @Prop({ required: true, type: Date })
  expiresAt: Date;

  // 선택 필드(date?) — 아직 유효한 토큰은 폐기 시각이 없습니다.
  @Prop({ type: Date, default: null })
  revokedAt?: Date;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
