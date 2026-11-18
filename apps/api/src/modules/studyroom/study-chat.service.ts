import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { ChatRoom } from '../social/schemas/chat-room.schema.js';
import { Message } from '../social/schemas/message.schema.js';
import { StudyRoom } from './schemas/study-room.schema.js';
import { Friendship } from '../social/schemas/friendship.schema.js';
import { UPLOAD_RULES } from '@notelink/shared';
import { BlobStorageService, uploadFolder } from '../upload/blob-storage.service.js';

/** 채팅 첨부를 읽을 수 있는 시간. 지나면 대화 기록을 다시 받아 새 주소를 쓴다 */
const ATTACHMENT_READ_MS = 60 * 60_000;
/** 첨부 종류 → 올린 경로의 종류(uploadFolder) */
const ATTACHMENT_STORAGE = { image: 'image', file: 'document' } as const;
type AttachmentKind = keyof typeof ATTACHMENT_STORAGE;

@Injectable()
export class StudyChatService {
  constructor(
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    @InjectModel(ChatRoom.name) private readonly chats: Model<ChatRoom>,
    @InjectModel(Message.name) private readonly messages: Model<Message>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Friendship.name) private readonly friendships: Model<Friendship>,
    // 채팅 첨부(사진 · 파일)의 주소를 확인하고 읽기 주소를 만든다. 없으면(저장소 미설정) 첨부를 받지 않는다
    @Optional() private readonly blobs?: BlobStorageService,
  ) {}

  async getDirectChat(userId: string, targetUserId: string) {
    if (!isValidObjectId(userId) || !isValidObjectId(targetUserId) || userId === targetUserId)
      throw this.notFound();
    const first = new Types.ObjectId(userId);
    const second = new Types.ObjectId(targetUserId);
    const userA = first.toHexString() < second.toHexString() ? first : second;
    const userB = userA === first ? second : first;
    const friendship = await this.friendships.exists({ userA, userB, status: 'accepted' });
    const activeUsers = await this.users.countDocuments({
      _id: { $in: [first, second] },
      deletedAt: null,
    });
    if (!friendship || activeUsers !== 2) throw this.notFound();
    const directKey = `${userA.toHexString()}:${userB.toHexString()}`;
    const now = new Date();
    try {
      return await this.chats
        .findOneAndUpdate(
          { directKey },
          {
            $setOnInsert: {
              type: 'direct',
              directKey,
              members: [
                { userId: userA, joinedAt: now, muted: false, leftAt: null },
                { userId: userB, joinedAt: now, muted: false, leftAt: null },
              ],
            },
          },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        )
        .lean()
        .orFail();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        const existing = await this.chats.findOne({ directKey }).lean();
        if (existing) return existing;
      }
      throw error;
    }
  }

  async sendRoomInvite(
    senderId: string,
    targetUserId: string,
    room: { _id: string; title: string; inviteCode: string },
    invitationId: string,
  ) {
    const chat = await this.getDirectChat(senderId, targetUserId);
    const sender = new Types.ObjectId(senderId);
    const target = new Types.ObjectId(targetUserId);
    const clientId = `room_invite_${invitationId}`;
    const key = { chatRoomId: chat._id, senderId: sender, clientId };
    const message = await this.messages
      .findOneAndUpdate(
        key,
        {
          $setOnInsert: {
            ...key,
            type: 'study_room_invite',
            text: `${room.title} 스터디룸에 초대했어요.`,
            studyRoomInvite: { roomId: room._id, title: room.title, inviteCode: room.inviteCode },
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .orFail();
    await this.chats.updateOne(
      { _id: chat._id, members: { $elemMatch: { userId: target, leftAt: null } } },
      {
        $set: {
          lastMessage: {
            type: 'study_room_invite',
            text: message.text,
            senderId: sender,
            createdAt: new Date(),
          },
        },
      },
    );
    const user = await this.users.findById(sender, { nickname: 1 }).lean();
    return this.serialize(message, user?.nickname);
  }

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
      .findOne({
        _id: new Types.ObjectId(chatId),
        type: { $in: ['study_room', 'direct'] },
      })
      .lean();
    if (!chat) throw this.notFound();
    if (chat.type === 'study_room' && chat.studyRoomId) {
      await this.requireMember(String(chat.studyRoomId), userId);
    } else if (chat.type === 'direct') {
      const member = chat.members.some((item) => item.userId.equals(userId) && !item.leftAt);
      if (!member) throw this.notFound();
      const other = chat.members.find((item) => !item.userId.equals(userId) && !item.leftAt);
      if (!other) throw this.notFound();
      const ids = [new Types.ObjectId(userId), other.userId].sort((a, b) =>
        a.toHexString().localeCompare(b.toHexString()),
      );
      if (!(await this.friendships.exists({ userA: ids[0], userB: ids[1], status: 'accepted' })))
        throw this.notFound();
    } else {
      throw this.notFound();
    }
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
    const chatRoomObjectId = new Types.ObjectId(chatId);
    const beforeId = before ? new Types.ObjectId(before) : undefined;
    const beforeMessage = beforeId
      ? await this.messages
          .findOne({ _id: beforeId, chatRoomId: chatRoomObjectId }, { createdAt: 1 })
          .lean<{ createdAt?: Date }>()
      : null;
    const beforeCreatedAt = beforeMessage?.createdAt ?? beforeId?.getTimestamp();
    const messages = await this.messages
      .find({
        chatRoomId: chatRoomObjectId,
        deletedAt: null,
        ...(beforeId && beforeCreatedAt
          ? {
              $or: [
                { createdAt: { $lt: beforeCreatedAt } },
                { createdAt: beforeCreatedAt, _id: { $lt: beforeId } },
              ],
            }
          : {}),
      })
      .sort({ createdAt: -1, _id: -1 })
      .limit(50)
      .lean();
    const users = await this.users
      .find({ _id: { $in: messages.map((m) => m.senderId) } }, { nickname: 1 })
      .lean();
    const names = new Map(users.map((u) => [String(u._id), u.nickname]));
    return Promise.all(
      messages.reverse().map((m) => this.serialize(m, names.get(String(m.senderId)))),
    );
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

  /**
   * 사진 · 파일 메시지. 앱이 채팅 경로(uploadFolder(…, 'chat'))에 먼저 올린 파일의 주소를 받는다.
   * 보낸 사람 본인의 채팅 경로 아래 `<uuid>.<확장자>`이고 실제로 있는 파일인지 확인한다(남의 파일 · 노트 파일을 보내지 못하게).
   * 같은 clientId로 다시 보내면 같은 메시지를 돌려준다(재연결 뒤 다시 보내기)
   */
  async sendAttachment(chatId: string, userId: string, attachment: unknown, clientId: unknown) {
    await this.requireChat(chatId, userId);
    const a = attachment as { blobUrl?: unknown; kind?: unknown; name?: unknown } | null;
    if (
      !a ||
      typeof a.blobUrl !== 'string' ||
      (a.kind !== 'image' && a.kind !== 'file') ||
      typeof a.name !== 'string' ||
      !a.name.trim() ||
      a.name.length > 200 ||
      typeof clientId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(clientId)
    ) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '첨부 형식이 올바르지 않습니다.',
      });
    }
    if (!this.blobs)
      throw new BadRequestException({ code: 'BAD_REQUEST', message: '첨부를 보낼 수 없어요.' });
    const kind = a.kind as AttachmentKind;
    const { sizeBytes } = await this.blobs.createReadAccess(a.blobUrl, 60_000, {
      prefix: uploadFolder(ATTACHMENT_STORAGE[kind], userId, 'chat'),
    });
    // 올리기 주소는 앱이 알린 크기로만 내준다. 실제로 올라간 파일이 상한을 넘으면 받지 않는다(Codex #507 리뷰)
    const maxBytes = UPLOAD_RULES[ATTACHMENT_STORAGE[kind]].maxBytes;
    if (sizeBytes !== undefined && sizeBytes > maxBytes)
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: `${Math.round(maxBytes / 1024 / 1024)}MB 이하 파일만 보낼 수 있어요.`,
      });
    const senderId = new Types.ObjectId(userId);
    const key = { chatRoomId: new Types.ObjectId(chatId), senderId, clientId };
    const stored = { blobUrl: a.blobUrl, name: a.name.trim(), sizeBytes: sizeBytes ?? 0 };
    let message;
    try {
      message = await this.messages
        .findOneAndUpdate(
          key,
          { $setOnInsert: { ...key, type: kind, text: null, attachment: stored } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .lean()
        .orFail();
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000)
        throw error;
      message = await this.messages.findOne(key).lean().orFail();
    }
    if (message.type !== kind || message.attachment?.blobUrl !== a.blobUrl)
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '이미 사용한 메시지 식별자입니다.',
      });
    const user = await this.users.findById(senderId, { nickname: 1 }).lean();
    return this.serialize(message, user?.nickname);
  }

  /** 저장한 첨부를 앱이 바로 열 수 있게 잠깐 읽을 수 있는 주소로 바꾼다. 만들지 못하면 첨부를 빼고 보낸다 */
  private async attachmentOf(m: Message) {
    if ((m.type !== 'image' && m.type !== 'file') || !m.attachment || !this.blobs) return undefined;
    try {
      const { readUrl } = await this.blobs.createReadAccess(
        m.attachment.blobUrl,
        ATTACHMENT_READ_MS,
      );
      return {
        kind: m.type as AttachmentKind,
        name: m.attachment.name,
        sizeBytes: m.attachment.sizeBytes,
        url: readUrl,
      };
    } catch {
      return undefined;
    }
  }

  private async serialize(
    m: Message & { _id: Types.ObjectId; createdAt?: Date },
    nickname?: string,
  ) {
    const attachment = await this.attachmentOf(m);
    return {
      _id: String(m._id),
      chatRoomId: String(m.chatRoomId),
      senderId: String(m.senderId),
      ...(nickname ? { senderNickname: nickname } : {}),
      type: m.type,
      text: m.text ?? null,
      sharedItemId: m.sharedItemId ? String(m.sharedItemId) : null,
      ...(m.studyRoomInvite ? { studyRoomInvite: m.studyRoomInvite } : {}),
      ...(attachment ? { attachment } : {}),
      createdAt: m.createdAt?.toISOString(),
      ...(m.clientId ? { clientId: m.clientId } : {}),
    };
  }

  private notFound() {
    return new NotFoundException({ code: 'NOT_FOUND', message: '채팅방을 찾을 수 없습니다.' });
  }
}
