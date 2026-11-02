import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

@Schema({ collection: 'messages', timestamps: { createdAt: true, updatedAt: false } })
export class Message {
  @Prop({ type: Types.ObjectId, ref: 'ChatRoom', required: true })
  chatRoomId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  senderId: Types.ObjectId;

  @Prop({ required: true, default: 'text' })
  type: string; // text, shared_item, system 등[cite: 28]

  @Prop()
  text?: string;

  @Prop({ type: Types.ObjectId, ref: 'Message' })
  chatMessageId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'RoomSharedItem' })
  sharedItemId?: Types.ObjectId;

  @Prop({ type: Object })
  sharePreview?: Record<string, unknown>;

  @Prop()
  deletedAt?: Date;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

// 채팅 조회는 항상 "이 방의 메시지를 최신순(=_id 역순)"으로 하므로 복합 인덱스를 둡니다.
// ObjectId(_id)는 생성 시각이 앞부분에 인코딩돼 있어 시간순 정렬·커서로 안전하게 쓸 수 있습니다.
MessageSchema.index({ chatRoomId: 1, _id: -1 });
