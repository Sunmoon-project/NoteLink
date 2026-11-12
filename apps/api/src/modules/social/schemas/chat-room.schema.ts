import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: ChatMember (채팅방 참여 유저)
@Schema({ _id: false })
export class ChatMember {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: Date })
  joinedAt: Date;

  @Prop({ type: Date, default: null })
  lastReadAt?: Date;

  @Prop({ required: true, type: Boolean, default: false })
  muted: boolean;

  @Prop({ type: Date, default: null })
  leftAt?: Date;
}
export const ChatMemberSchema = SchemaFactory.createForClass(ChatMember);

// 메인 스키마: chat_rooms
export type ChatRoomDocument = HydratedDocument<ChatRoom>;

@Schema({ collection: 'chat_rooms', timestamps: true })
export class ChatRoom {
  @Prop({ required: true, type: String })
  type: string; // direct(1:1), study_room(그룹) 등

  @Prop({ type: Types.ObjectId, ref: 'StudyRoom' })
  studyRoomId?: Types.ObjectId;

  @Prop({ type: Object })
  lastMessage?: Record<string, unknown>; // 방 목록에 보여줄 마지막 메시지 객체

  @Prop({ type: [ChatMemberSchema], default: [] })
  members: ChatMember[]; // 채팅 참여 유저 목록

  @Prop()
  title?: string;
}

export const ChatRoomSchema = SchemaFactory.createForClass(ChatRoom);
ChatRoomSchema.index(
  { studyRoomId: 1 },
  { unique: true, partialFilterExpression: { studyRoomId: { $type: 'objectId' } } },
);
