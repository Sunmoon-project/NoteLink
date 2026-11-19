import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NotificationDocument = HydratedDocument<Notification>;

// notifications (공용 스키마 packages/shared Notification을 따름)
@Schema({ collection: 'notifications', timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String })
  type: string;

  @Prop({ required: true, type: String })
  title: string;

  @Prop({ required: true, type: String })
  body: string;

  @Prop({ type: Object, default: null })
  data?: Record<string, unknown> | null;

  @Prop({ type: Date, default: null })
  readAt?: Date | null;

  /** 같은 값의 예전 알림은 새 알림으로 바뀐다(NotificationService, 푸시 collapseId와 같다) */
  @Prop({ type: String, default: null })
  collapseKey?: string | null;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// 알림함 목록(최근 것부터) · 읽지 않은 수
NotificationSchema.index({ userId: 1, _id: -1 });
NotificationSchema.index({ userId: 1, readAt: 1 });
NotificationSchema.index({ userId: 1, collapseKey: 1 });
// ponytail: 알림함은 90일만 둔다(TTL). 오래된 알림을 남겨야 하면 늘린다
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
