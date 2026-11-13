import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: CalendarSubscriber (공유받은 유저 목록)
@Schema({ _id: false })
export class CalendarSubscriber {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, default: Date.now })
  addedAt: Date;
}
export const CalendarSubscriberSchema = SchemaFactory.createForClass(CalendarSubscriber);

// 메인 스키마: calendar_shares
export type CalendarShareDocument = HydratedDocument<CalendarShare>;

@Schema({ collection: 'calendar_shares', timestamps: true })
export class CalendarShare {
  @Prop({ required: true, unique: true })
  token: string; // 공유 URL 고유 키

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ required: true, type: String })
  rangeStart: string; // YYYY-MM-DD

  @Prop({ required: true, type: String })
  rangeEnd: string; // YYYY-MM-DD

  @Prop({ type: [String], default: [] })
  scopes: string[]; // 공유 범위 지정

  @Prop({ type: [CalendarSubscriberSchema], default: [] })
  subscribers: CalendarSubscriber[]; // 구독 유저 배열

  @Prop({ type: Date, default: null })
  expiresAt?: Date;

  @Prop({ type: Date, default: null })
  revokedAt?: Date;
}

export const CalendarShareSchema = SchemaFactory.createForClass(CalendarShare);

// 아래 두 인덱스는 캘린더 공유 API(FR-13)에서 추가했다 (필드는 그대로)
CalendarShareSchema.index({ ownerId: 1, revokedAt: 1, createdAt: -1 }); // 내가 만든 링크 목록
CalendarShareSchema.index({ 'subscribers.userId': 1 }); // 내가 받은 캘린더
