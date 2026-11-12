import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

export type UploadTicketDocument = HydratedDocument<UploadTicket>;

/**
 * 올리기 주소를 내준 기록. SAS로는 올리는 크기를 묶을 수 없어, 주소가 만료된 뒤 서버가 실제 Blob을 확인하는 데 쓴다.
 * 확인 · 정리(UploadSweeper)가 끝나면 지운다. 자료로 등록된 파일은 status를 used로 바꿔 정리에서 뺀다.
 */
@Schema({ collection: 'upload_tickets', timestamps: true })
export class UploadTicket {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  /** 컨테이너 안의 Blob 이름({사용자 ID}/{무작위 ID}.{확장자}) */
  @Prop({ required: true, type: String, unique: true })
  blobName: string;

  /** 이 종류의 크기 상한(UPLOAD_RULES). 실제 Blob이 이보다 크면 지운다 */
  @Prop({ required: true, type: Number })
  maxBytes: number;

  /** issued: 주소만 내줌 · used: 자료로 등록됨 */
  @Prop({ required: true, type: String, enum: ['issued', 'used'], default: 'issued' })
  status: string;

  /** 올리기 주소(SAS)가 만료되는 시각 */
  @Prop({ required: true, type: Date })
  expiresAt: Date;

  /** 실제 크기를 확인한 시각. 아직이면 null */
  @Prop({ type: Date, default: null })
  checkedAt?: Date | null;
}

export const UploadTicketSchema = SchemaFactory.createForClass(UploadTicket);

// 사용자별 최근 발급 수 세기
UploadTicketSchema.index({ ownerId: 1, createdAt: -1 });
// 확인 · 정리할 기록 찾기
UploadTicketSchema.index({ status: 1, expiresAt: 1 });
