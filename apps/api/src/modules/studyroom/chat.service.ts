import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { ChatRoom, ChatRoomDocument } from '../social/schemas/chat-room.schema.js';
import { Message, MessageDocument } from '../social/schemas/message.schema.js';
import { MESSAGE_TYPES } from './chat.events.js';
import { ROOM_MEMBER_STATUS } from './study-room.constants.js';
import { StudyRoom, StudyRoomDocument } from './schemas/study-room.schema.js';

export interface ChatMessageView {
  id: string;
  roomId: string;
  senderId: string;
  type: string;
  text?: string;
  createdAt: string;
}

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(StudyRoom.name)
    private readonly studyRoomModel: Model<StudyRoomDocument>,
    @InjectModel(ChatRoom.name)
    private readonly chatRoomModel: Model<ChatRoomDocument>,
    @InjectModel(Message.name)
    private readonly messageModel: Model<MessageDocument>,
  ) {}

  /**
   * 해당 유저가 그 스터디룸의 참여 멤버인지 확인합니다.
   * 채팅방에 입장하거나 메시지를 보내기 전에 호출해, 외부인의 접근을 막습니다.
   */
  async assertMember(userId: string, roomId: string): Promise<void> {
    if (!Types.ObjectId.isValid(roomId)) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }

    const room = await this.studyRoomModel.findById(roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }

    const userObjectId = new Types.ObjectId(userId);
    const isMember = room.members.some(
      (m) =>
        m.userId.equals(userObjectId) &&
        m.status === ROOM_MEMBER_STATUS.JOINED,
    );
    if (!isMember) {
      throw new ForbiddenException({
        code: 'NOT_A_MEMBER',
        message: '스터디룸에 참여한 사용자만 채팅할 수 있습니다.',
      });
    }
  }

  /** 메시지를 messages 컬렉션에 저장하고, 방송용 뷰로 돌려줍니다. */
  async saveMessage(
    userId: string,
    roomId: string,
    text: string,
  ): Promise<ChatMessageView> {
    // 스터디룸에 연결된 chat_room을 찾습니다(없으면 안전하게 생성).
    const chatRoom = await this.getOrCreateChatRoom(roomId);

    const message = await this.messageModel.create({
      chatRoomId: chatRoom._id,
      senderId: new Types.ObjectId(userId),
      type: MESSAGE_TYPES.TEXT,
      text,
    });

    // 방 목록에서 "마지막 메시지"로 보여줄 요약을 갱신합니다.
    chatRoom.lastMessage = {
      text,
      senderId: userId,
      createdAt: message.get('createdAt'),
    };
    await chatRoom.save();

    return this.toMessageView(message, roomId);
  }

  /**
   * 메시지 히스토리를 커서 기반으로 가져옵니다. (무한 스크롤용)
   * - before 없이: 가장 최근 limit개
   * - before=<메시지 id>: 그 메시지보다 "이전" 것 limit개 (위로 스크롤)
   * 반환은 항상 오래된→최신 순입니다.
   *
   * 정렬·커서에 createdAt 대신 _id를 씁니다. ObjectId는 시간순이라
   * 같은 밀리초에 들어온 메시지도 순서가 뒤집히지 않습니다(안정 정렬).
   */
  async getHistory(
    roomId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<ChatMessageView[]> {
    const chatRoom = await this.chatRoomModel.findOne({
      studyRoomId: new Types.ObjectId(roomId),
    });
    if (!chatRoom) {
      return [];
    }

    const safeLimit = Math.min(Math.max(options.limit ?? 30, 1), 100);

    const filter: Record<string, unknown> = {
      chatRoomId: chatRoom._id,
      deletedAt: { $exists: false },
    };
    // before 커서: 이 id보다 이전(작은) 메시지만. 잘못된 id는 무시합니다.
    if (options.before && Types.ObjectId.isValid(options.before)) {
      filter._id = { $lt: new Types.ObjectId(options.before) };
    }

    const docs = await this.messageModel
      .find(filter)
      .sort({ _id: -1 }) // 최신순으로 limit개를 집은 뒤
      .limit(safeLimit)
      .exec();

    // 화면 표시용으로 오래된→최신 순으로 뒤집어 반환합니다.
    return docs.reverse().map((m) => this.toMessageView(m, roomId));
  }

  /** Message 문서를 방송·응답용 뷰로 변환합니다. */
  private toMessageView(m: MessageDocument, roomId: string): ChatMessageView {
    return {
      id: m._id.toString(),
      roomId,
      senderId: m.senderId.toString(),
      type: m.type,
      text: m.text,
      createdAt: (m.get('createdAt') as Date).toISOString(),
    };
  }

  /** 스터디룸에 연결된 chat_room을 찾고, 없으면 만듭니다. */
  private async getOrCreateChatRoom(
    roomId: string,
  ): Promise<ChatRoomDocument> {
    const studyRoomObjectId = new Types.ObjectId(roomId);
    const existing = await this.chatRoomModel.findOne({
      studyRoomId: studyRoomObjectId,
    });
    if (existing) {
      return existing;
    }
    return this.chatRoomModel.create({
      type: 'study_room',
      studyRoomId: studyRoomObjectId,
    });
  }
}
