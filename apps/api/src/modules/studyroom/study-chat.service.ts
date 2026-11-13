import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { ChatRoom } from '../social/schemas/chat-room.schema.js';
import { Message } from '../social/schemas/message.schema.js';
import { StudyRoom } from './schemas/study-room.schema.js';

@Injectable()
export class StudyChatService {
  constructor(
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    @InjectModel(ChatRoom.name) private readonly chats: Model<ChatRoom>,
    @InjectModel(Message.name) private readonly messages: Model<Message>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  async requireMember(roomId: string, userId: string) {
    if (!isValidObjectId(roomId) || !isValidObjectId(userId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '스터디룸을 찾을 수 없습니다.',
      });
    }

    const room = await this.rooms
      .findOne({
        _id: new Types.ObjectId(roomId),
        closedAt: null,
        members: {
          $elemMatch: {
            userId: new Types.ObjectId(userId),
            status: 'joined',
          },
        },
      })
      .lean();

    if (!room) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '스터디룸을 찾을 수 없습니다.',
      });
    }

    return room;
  }

  async getChat(roomId: string, userId: string) {
    await this.requireMember(roomId, userId);

    const studyRoomId = new Types.ObjectId(roomId);
    const filter = {
      type: 'study_room',
      studyRoomId,
    };

    try {
      return await this.chats
        .findOneAndUpdate(
          filter,
          {
            $setOnInsert: {
              ...filter,
              members: [],
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        )
        .lean()
        .orFail();
    } catch (error) {
      // 동시에 생성하려다 유일 인덱스에 충돌하면 이미 생성된 방을 조회한다.
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        const existing = await this.chats.findOne(filter).lean();
        if (existing) return existing;
      }

      throw error;
    }
  }

  async requireChat(chatId: string, userId: string) {
    if (!isValidObjectId(chatId)) throw this.notFound();
    const chat = await this.chats
      .findOne({ _id: new Types.ObjectId(chatId), type: 'study_room' })
      .lean();
    if (!chat?.studyRoomId) throw this.notFound();
    await this.requireMember(String(chat.studyRoomId), userId);
    return chat;
  }

  async history(chatId: string, userId: string, before?: string) {
    await this.requireChat(chatId, userId);
    if (before !== undefined && !isValidObjectId(before)) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '대화 기록 위치가 올바르지 않습니다.',
      });
    }
    const messages = await this.messages
      .find({
        chatRoomId: new Types.ObjectId(chatId),
        deletedAt: null,
        ...(before ? { _id: { $lt: new Types.ObjectId(before) } } : {}),
      })
      .sort({ _id: -1 })
      .limit(50)
      .lean();
    const users = await this.users
      .find({ _id: { $in: messages.map((m) => m.senderId) } }, { nickname: 1 })
      .lean();
    const names = new Map(users.map((u) => [String(u._id), u.nickname]));
    return messages.reverse().map((m) => this.serialize(m, names.get(String(m.senderId))));
  }

  async send(chatId: string, userId: string, text: unknown, clientId: unknown) {
    await this.requireChat(chatId, userId);
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 2000 ||
      typeof clientId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(clientId)
    ) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '메시지 형식이 올바르지 않습니다.',
      });
    }
    const senderId = new Types.ObjectId(userId);
    const key = { chatRoomId: new Types.ObjectId(chatId), senderId, clientId };
    let message;
    try {
      message = await this.messages
        .findOneAndUpdate(
          key,
          { $setOnInsert: { ...key, type: 'text', text: text.trim() } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .lean()
        .orFail();
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000)
        throw error;
      message = await this.messages.findOne(key).lean().orFail();
    }
    if (message.text !== text.trim())
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '이미 사용한 메시지 식별자입니다.',
      });
    const user = await this.users.findById(senderId, { nickname: 1 }).lean();
    return this.serialize(message, user?.nickname);
  }

  private serialize(m: Message & { _id: Types.ObjectId; createdAt?: Date }, nickname?: string) {
    return {
      _id: String(m._id),
      chatRoomId: String(m.chatRoomId),
      senderId: String(m.senderId),
      ...(nickname ? { senderNickname: nickname } : {}),
      type: m.type,
      text: m.text ?? null,
      sharedItemId: m.sharedItemId ? String(m.sharedItemId) : null,
      createdAt: m.createdAt?.toISOString(),
      ...(m.clientId ? { clientId: m.clientId } : {}),
    };
  }

  private notFound() {
    return new NotFoundException({ code: 'NOT_FOUND', message: '채팅방을 찾을 수 없습니다.' });
  }
}
