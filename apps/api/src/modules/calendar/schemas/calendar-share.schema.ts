import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: CalendarSubscriber (공유받은 유저 목록)[cite: 27]
@Schema({ _id: false })
export class CalendarSubscriber {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, default: Date.now })
  addedAt: Date;
}
export const CalendarSubscriberSchema = SchemaFactory.createForClass(CalendarSubscriber);

// 메인 스키마: calendar_shares[cite: 27]
export type CalendarShareDocument = HydratedDocument<CalendarShare>;

@Schema({ collection: 'calendar_shares', timestamps: true })
export class CalendarShare {
  @Prop({ required: true, unique: true })
  token: string; // 공유 URL 고유 키[cite: 27]

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ required: true })
  rangeStart: string; // YYYY-MM-DD[cite: 27]

  @Prop({ required: true })
  rangeEnd: string; // YYYY-MM-DD[cite: 27]

  @Prop({ type: [String], default: [] })
  scopes: string[]; // 공유 범위 지정[cite: 27]

  @Prop({ type: [CalendarSubscriberSchema], default: [] })
  subscribers: CalendarSubscriber[]; // 구독 유저 배열[cite: 27]

  @Prop()
  expiresAt?: Date;

  @Prop()
  revokedAt?: Date;
}

export const CalendarShareSchema = SchemaFactory.createForClass(CalendarShare);
