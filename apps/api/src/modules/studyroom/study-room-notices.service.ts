import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { NotificationService } from '../notification/notification.service.js';
import { ChatRoom } from '../social/schemas/chat-room.schema.js';
import { StudyRoom } from './schemas/study-room.schema.js';

/** StudyChatService.serialize가 돌려주는 메시지 중 알림에 쓰는 부분 */
export type ChatMessageView = {
  _id: string;
  chatRoomId: string;
  senderId: string;
  senderNickname?: string;
  type: string;
  text: string | null;
  studyRoomInvite?: { roomId?: unknown; title?: unknown } & Record<string, unknown>;
};

const PREVIEW_MAX = 80;

function preview(m: ChatMessageView): string {
  if (m.type === 'image') return '사진을 보냈어요';
  if (m.type === 'file') return '파일을 보냈어요';
  if (m.type === 'shared_item') return '노트를 공유했어요';
  const text = (m.text ?? '').replace(/\s+/g, ' ').trim();
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}

/**
 * 채팅 · 스터디룸 알림(FR-16 · FR-30 · FR-35, #560). 게이트웨이 · 컨트롤러는 메시지 저장 · 퇴장 조치 뒤 이것만 부른다.
 * 알림은 덤이라 실패해도 던지지 않는다(NotificationService도 던지지 않는다)
 */
@Injectable()
export class StudyRoomNoticesService {
  private readonly logger = new Logger(StudyRoomNoticesService.name);

  constructor(
    @InjectModel(ChatRoom.name) private readonly chats: Model<ChatRoom>,
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * 새 채팅 메시지. `delivered`는 소켓으로 이미 받은(그 채팅을 보고 있는) 사람 — 그 사람과 보낸 사람은 뺀다.
   * 같은 채팅은 기기에서 마지막 것 하나로 묶인다(collapseId). 초대 카드는 방 활동 알림으로 알림함에도 남긴다
   */
  async chatMessage(message: ChatMessageView, delivered: string[]): Promise<void> {
    try {
      if (!isValidObjectId(message.chatRoomId)) return;
      const chat = await this.chats
        .findById(message.chatRoomId, { type: 1, studyRoomId: 1, members: 1 })
        .lean();
      if (!chat) return;
      const sender = message.senderId;
      const name = message.senderNickname ?? '알 수 없는 사용자';
      const chatRoomId = String(chat._id);

      if (chat.type === 'direct') {
        const others = chat.members
          .filter((m) => !m.leftAt && String(m.userId) !== sender)
          .map((m) => m.userId);
        if (message.type === 'study_room_invite') {
          const invite = message.studyRoomInvite ?? {};
          await this.notifications.notify({
            userIds: others,
            category: 'room',
            type: 'room-invite',
            title: '스터디룸 초대',
            body: `${name}님이 「${String(invite.title ?? '')}」 스터디룸에 초대했어요`,
            data: { chatRoomId, roomId: String(invite.roomId ?? ''), userId: sender },
            collapseId: `room-invite:${message._id}`,
          });
          return;
        }
        await this.pushChat(
          others.filter((id) => !delivered.includes(String(id))),
          { title: name, body: preview(message) },
          { chatRoomId, messageId: message._id, userId: sender },
        );
        return;
      }

      if (chat.type === 'study_room' && chat.studyRoomId) {
        const room = await this.rooms
          .findOne({ _id: chat.studyRoomId, closedAt: null }, { title: 1, members: 1 })
          .lean();
        if (!room) return;
        // ponytail: 메시지마다 멤버 전원을 한 번에 보낸다(Expo 100개 배치). 큰 방에서 느려지면 큐 · 몇 초 묶어 보내기로
        const targets = room.members
          .filter((m) => m.status === 'joined')
          .map((m) => m.userId)
          .filter((id) => String(id) !== sender && !delivered.includes(String(id)));
        await this.pushChat(
          targets,
          { title: room.title, body: `${name}: ${preview(message)}` },
          { chatRoomId, roomId: String(room._id), messageId: message._id, userId: sender },
        );
      }
    } catch (error) {
      this.logger.warn(`채팅 알림을 보내지 못했어요(${message.chatRoomId}): ${String(error)}`);
    }
  }

  /** 퇴장 조치 당한 사람에게. 방 활동 알림을 꺼도 간다 */
  async kicked(roomId: string, userId: string, now = new Date()): Promise<void> {
    try {
      if (!isValidObjectId(roomId)) return;
      const room = await this.rooms.findById(roomId, { title: 1 }).lean();
      if (!room) return;
      await this.notifications.notify(
        {
          userIds: [userId],
          category: 'room',
          essential: true,
          type: 'room-kicked',
          title: '스터디룸',
          body: `「${room.title}」에서 내보내졌어요`,
          data: { roomId },
          collapseId: `room-kick:${roomId}`,
        },
        now,
      );
    } catch (error) {
      this.logger.warn(`퇴장 조치 알림을 보내지 못했어요(${roomId}): ${String(error)}`);
    }
  }

  private pushChat(
    userIds: Types.ObjectId[],
    text: { title: string; body: string },
    data: Record<string, unknown>,
  ) {
    if (!userIds.length) return Promise.resolve();
    const id = String(data.chatRoomId);
    // ponytail: 같은 채팅은 기기에서 마지막 메시지 하나로 바뀔 뿐 「새 메시지 N개」로 세지는 않는다(메시지마다 푸시).
    // 연속 전송이 시끄러우면 몇 초 디바운스해 개수로 묶는다
    return this.notifications.notify({
      userIds,
      category: 'chat',
      type: 'chat-message',
      ...text,
      data,
      inbox: false,
      collapseId: `chat:${id}`,
      threadId: `chat:${id}`,
    });
  }
}
