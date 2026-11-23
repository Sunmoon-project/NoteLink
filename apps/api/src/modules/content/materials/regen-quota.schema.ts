import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

/**
 * 정리 결과 「다시 만들기」를 하루(서울 날짜)에 쓴 횟수. 사용자 · 날짜마다 문서 하나, 이틀 뒤 MongoDB가 지운다.
 * 올리기 주소 한도(upload_quotas)와 같은 방식: 한도 안일 때만 하나 올리는 한 번의 업데이트라 동시에 와도 넘지 않는다
 */
@Schema({ collection: 'regen_quotas' })
export class RegenQuota {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  /** 서울 날짜 YYYY-MM-DD */
  @Prop({ required: true, type: String })
  day: string;

  /** 기본값을 두지 않는다(만들 때 $inc로 넣는 값과 겹치지 않게) */
  @Prop({ required: true, type: Number })
  count: number;

  /** 항목 0개 실패로 돌려준 횟수(FR-19). 하루 REGEN_REFUND_MAX 번까지만 돌려준다. 옛 문서에는 없다 */
  @Prop({ type: Number })
  refunds?: number;

  /** 돌려준 다시 만들기 작업 id. 같은 작업을 두 번 돌려주지 않게(옮기기 전에 돌려주고, 실패하면 다음 조회가 다시 시도) */
  @Prop({ type: [Types.ObjectId], default: undefined })
  refundedJobs?: Types.ObjectId[];

  @Prop({ required: true, type: Date })
  expiresAt: Date;
}

export const RegenQuotaSchema = SchemaFactory.createForClass(RegenQuota);

// 사용자 · 날짜마다 하나. 한도에 닿은 뒤의 요청은 이 색인에 걸려 새 문서를 만들지 못한다
RegenQuotaSchema.index({ ownerId: 1, day: 1 }, { unique: true });
RegenQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
