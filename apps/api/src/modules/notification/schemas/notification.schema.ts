import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NotificationDocument = HydratedDocument<Notification>;

// notifications (공용 스키마 packages/shared Notification을 따름)
@Schema({ collection: 'notifications', timestamps: true })
export class Notification {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String})
  type: string;

  @Prop({ required: true, type: String })
  title: string;

  @Prop({ required: true, type: String })
  body: string;

  @Prop({ type: Object, default: null })
  data?: Record<string, unknown> | null;

  @Prop({ type: Date, default: null })
  readAt?: Date | null;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
