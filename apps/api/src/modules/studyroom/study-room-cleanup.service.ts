import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ChatRoom } from '../social/schemas/chat-room.schema.js';
import { Message } from '../social/schemas/message.schema.js';
import { StudyRoom } from './schemas/study-room.schema.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;

@Injectable()
export class StudyRoomCleanupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StudyRoomCleanupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    @InjectModel(ChatRoom.name) private readonly chats: Model<ChatRoom>,
    @InjectModel(Message.name) private readonly messages: Model<Message>,
  ) {}

  onApplicationBootstrap() {
    void this.runScheduledCleanup();
    this.timer = setInterval(() => void this.runScheduledCleanup(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async runScheduledCleanup() {
    if (this.running) return;
    this.running = true;
    try {
      await this.cleanup(new Date());
    } catch (error) {
      this.logger.error('만료된 스터디룸 정리에 실패했습니다. 다음 실행에 다시 시도합니다.', error);
    } finally {
      this.running = false;
    }
  }

  async cleanup(now: Date) {
    // 예약된 빈 방만 정리한다. 기존에 닫힌 방은 자동 삭제 대상으로 바꾸지 않는다.
    const filter = { deleteAfter: { $lte: now }, closedAt: { $ne: null }, memberCount: 0 };
    const expired = await this.rooms
      .find(filter, { _id: 1 })
      .sort({ deleteAfter: 1 })
      .limit(CLEANUP_BATCH_SIZE)
      .lean();
    for (const room of expired) {
      const chats = await this.chats.find({ studyRoomId: room._id }, { _id: 1 }).lean();
      const chatIds = chats.map((chat) => chat._id);
      if (chatIds.length) {
        await this.messages.deleteMany({ chatRoomId: { $in: chatIds } });
        await this.chats.deleteMany({ _id: { $in: chatIds } });
      }
      await this.rooms.deleteOne({ ...filter, _id: room._id });
    }
  }
}
