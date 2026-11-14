import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

export type UploadQuotaDocument = HydratedDocument<UploadQuota>;

/**
 * 사용자가 한 구간 동안 받은 올리기 주소 수. 사용자 · 구간마다 문서 하나를 두고, 구간이 끝나면 MongoDB가 지운다.
 */
@Schema({ collection: 'upload_quotas' })
export class UploadQuota {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  /** 구간이 시작한 시각 */
  @Prop({ required: true, type: Date })
  windowStart: Date;

  /** 이 구간에 내준 주소 수. 기본값을 두지 않는다(만들 때 $inc로 넣는 값과 겹치지 않게) */
  @Prop({ required: true, type: Number })
  count: number;

  /** 이 시각이 지나면 MongoDB가 문서를 지운다 */
  @Prop({ required: true, type: Date })
  expiresAt: Date;
}

export const UploadQuotaSchema = SchemaFactory.createForClass(UploadQuota);

// 사용자 · 구간마다 하나. 한도에 닿은 뒤의 요청은 이 색인에 걸려 새 문서를 만들지 못한다
UploadQuotaSchema.index({ ownerId: 1, windowStart: 1 }, { unique: true });
UploadQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
