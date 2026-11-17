import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

@Schema({ collection: 'messages', timestamps: { createdAt: true, updatedAt: false } })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'ChatRoom', required: true })
  chatRoomId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  senderId: Types.ObjectId;

  @Prop({ required: true, type: String, default: 'text' })
  type: string; // text, shared_item, system 등

  @Prop({ type: String, default: null })
  text?: string | null;

  @Prop({ type: String })
  clientId?: string;

  @Prop({ type: Types.ObjectId, ref: 'Message' })
  chatMessageId?: Types.ObjectId;

  @Prop({ type: Object, default: null })
  studyRoomInvite?: { roomId: string; title: string; inviteCode: string } | null;

  @Prop({ type: Types.ObjectId, ref: 'RoomSharedItem' })
  sharedItemId?: Types.ObjectId;

  @Prop({ type: Object })
  sharePreview?: Record<string, unknown>;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// 대화 기록은 생성 시각과 _id를 함께 정렬·페이지 처리한다.
MessageSchema.index({ chatRoomId: 1, createdAt: -1, _id: -1 });
MessageSchema.index({ 'sharePreview.materialId': 1, type: 1, deletedAt: 1 });
MessageSchema.index(
  { chatRoomId: 1, senderId: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } },
);
