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

  /**
   * 갱신(rotate)이 이 토큰을 쓰는 중이라는 표시(갱신마다 새 값). 갱신이 DB 오류로 끝나면 이 값이 그대로일 때만
   * 토큰을 되살린다. 로그아웃 · 로그인 끊기는 이 값을 지워서, 그사이(같은 밀리초여도) 끊은 토큰은 되살아나지 않는다
   */
  @Prop({ type: String, default: null })
  claimId?: string | null;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
