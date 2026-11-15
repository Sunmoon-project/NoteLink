import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  TimerRule as TimerRuleSchema,
  nextRoomTimerTransitionAt,
  roomTimerState,
  type TimerRule,
} from '@notelink/shared';
import { isValidObjectId, type Model, Types } from 'mongoose';
import { Device } from '../users/schemas/device.schema.js';
import { ExpoPushService, type ExpoPushMessage } from '../notification/expo-push.service.js';
import { StudyRoom } from './schemas/study-room.schema.js';

const TIMER_SCAN_MS = 5_000;
const TIMER_SCAN_LIMIT = 100;
const PUSH_LEASE_MS = 30_000;
const EXPO_PUSH_TOKEN = /^(?:Expo|Exponent)PushToken\[[^\]]+\]$/;

type TimerPhase = 'focus' | 'break' | 'period' | 'completed';
type PendingTimerNotification = {
  transitionAt: Date;
  phase: TimerPhase;
  title: string;
  body: string;
};
type DueTimerRoom = Pick<
  StudyRoom,
  'title' | 'members' | 'timerRule' | 'timerStartedAt' | 'timerNextNotificationAt' | 'timerRevision'
> & { _id: Types.ObjectId };

/** 타이머 단계가 바뀌면 현재 joined 멤버들의 기기에 소리 있는 푸시를 보낸다. */
@Injectable()
export class RoomTimerNotificationsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RoomTimerNotificationsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly push: ExpoPushService,
  ) {}

  onApplicationBootstrap(): void {
    void this.runOnce().catch((error: unknown) => this.logFailure(error));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.logFailure(error));
    }, TIMER_SCAN_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 테스트와 운영 스케줄러가 공유하는 한 번의 due/pending 처리 */
  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = await this.rooms
        .find(
          { closedAt: null, timerPendingNotification: { $ne: null } },
          { _id: 1, timerRevision: 1 },
        )
        .limit(TIMER_SCAN_LIMIT)
        .lean();
      for (const room of pending) {
        await this.deliverPending(String(room._id), room.timerRevision ?? 0);
      }

      const due = await this.rooms
        .find(
          {
            closedAt: null,
            timerPendingNotification: null,
            timerNextNotificationAt: { $lte: now },
          },
          {
            _id: 1,
            title: 1,
            members: 1,
            timerRule: 1,
            timerStartedAt: 1,
            timerNextNotificationAt: 1,
            timerRevision: 1,
          },
        )
        .sort({ timerNextNotificationAt: 1 })
        .limit(TIMER_SCAN_LIMIT)
        .lean();

      for (const room of due) await this.queueTransition(room, now);
    } finally {
      this.running = false;
    }
  }

  private async queueTransition(room: DueTimerRoom, now: Date): Promise<void> {
    const parsed = TimerRuleSchema.safeParse(room.timerRule);
    if (!parsed.success) {
      await this.rooms.updateOne(
        {
          _id: room._id,
          timerRevision: room.timerRevision ?? 0,
          timerNextNotificationAt: room.timerNextNotificationAt,
        },
        { $set: { timerNextNotificationAt: null } },
      );
      return;
    }

    const rule: TimerRule = parsed.data;
    const state = roomTimerState(rule, room.timerStartedAt, now.getTime());
    const nextTransitionAt = nextRoomTimerTransitionAt(rule, room.timerStartedAt, now.getTime());
    const nextNotificationAt = nextTransitionAt ? new Date(nextTransitionAt) : null;
    const pending = this.pendingFor(room.title, rule, state, room.timerNextNotificationAt ?? now);
    const claimed = await this.rooms.updateOne(
      {
        _id: room._id,
        closedAt: null,
        timerRevision: room.timerRevision ?? 0,
        timerNextNotificationAt: room.timerNextNotificationAt,
        timerPendingNotification: null,
      },
      {
        $set: {
          timerNextNotificationAt: nextNotificationAt,
          timerPendingNotification: pending,
          timerPendingLeaseUntil: null,
        },
      },
    );
    if (!claimed.matchedCount || !pending) return;
    await this.deliverPending(String(room._id), room.timerRevision ?? 0);
  }

  private pendingFor(
    roomTitle: string,
    rule: TimerRule,
    state: ReturnType<typeof roomTimerState>,
    transitionAt: Date,
  ): PendingTimerNotification | null {
    if (rule.type === 'pomodoro' && rule.breakMin === 0 && state?.phase === 'focus') return null;
    const phase: TimerPhase = state?.phase ?? (rule.type === 'period' ? 'break' : 'completed');
    let body: string;
    if (phase === 'completed') body = '공동 타이머가 끝났어요.';
    else if (rule.type === 'period') {
      body =
        phase === 'period'
          ? '교시가 시작됐어요. 함께 집중해 보세요.'
          : '교시가 끝났어요. 다음 교시를 기다려요.';
    } else {
      body =
        phase === 'break'
          ? '집중 시간이 끝났어요. 잠시 쉬어 가세요.'
          : '휴식 시간이 끝났어요. 다시 집중해요.';
    }
    return {
      transitionAt: new Date(transitionAt),
      phase,
      title: `${roomTitle} 타이머`,
      body,
    };
  }

  private async deliverPending(roomId: string, revision: number): Promise<void> {
    if (!isValidObjectId(roomId)) return;
    const id = new Types.ObjectId(roomId);
    const leaseAcquiredAt = new Date();
    const claimed = await this.rooms.updateOne(
      {
        _id: id,
        closedAt: null,
        timerRevision: revision,
        timerPendingNotification: { $ne: null },
        $or: [
          { timerPendingLeaseUntil: null },
          { timerPendingLeaseUntil: { $lte: leaseAcquiredAt } },
        ],
      },
      {
        $set: {
          timerPendingLeaseUntil: new Date(leaseAcquiredAt.getTime() + PUSH_LEASE_MS),
        },
      },
    );
    if (!claimed.matchedCount) return;

    const room = await this.rooms
      .findOne({ _id: id, closedAt: null, timerRevision: revision })
      .lean();
    const pending = room?.timerPendingNotification as PendingTimerNotification | null | undefined;
    if (!room || !pending) return;

    try {
      const joinedUserIds = room.members
        .filter((member) => member.status === 'joined')
        .map((member) => member.userId);
      if (!joinedUserIds.length) {
        await this.clearPending(id, revision, pending.transitionAt);
        return;
      }

      const devices = await this.devices
        .find({ userId: { $in: joinedUserIds } }, { pushToken: 1 })
        .lean();
      const tokens = devices
        .map((device) => device.pushToken)
        .filter((token) => EXPO_PUSH_TOKEN.test(token));
      if (!tokens.length) {
        await this.clearPending(id, revision, pending.transitionAt);
        return;
      }

      const eventId = `${roomId}:${pending.transitionAt.toISOString()}`;
      const messages: ExpoPushMessage[] = tokens.map((to) => ({
        to,
        title: pending.title,
        body: pending.body,
        data: { type: 'study-room-timer', roomId, phase: pending.phase },
        sound: 'default',
        priority: 'high',
        channelId: 'study-room-timer',
        collapseId: eventId,
        threadId: `study-room-${roomId}`,
      }));
      const result = await this.push.send(messages);
      if (result.invalidTokens.length)
        await this.devices.deleteMany({ pushToken: { $in: result.invalidTokens } });
      if (result.failedTickets.length)
        this.logger.warn(
          `일부 기기 푸시 ticket이 거부되어 해당 전환의 재전송을 생략합니다: ${result.failedTickets
            .map(({ error }) => error)
            .join(', ')}`,
        );
      await this.clearPending(id, revision, pending.transitionAt);
    } catch (error) {
      this.logger.warn(`스터디룸 타이머 푸시 전송을 재시도합니다: ${String(error)}`);
    }
  }

  private clearPending(id: Types.ObjectId, revision: number, transitionAt: Date) {
    return this.rooms.updateOne(
      {
        _id: id,
        timerRevision: revision,
        'timerPendingNotification.transitionAt': transitionAt,
      },
      { $set: { timerPendingNotification: null, timerPendingLeaseUntil: null } },
    );
  }

  private logFailure(error: unknown): void {
    this.logger.warn(`스터디룸 타이머 점검을 다시 시도합니다: ${String(error)}`);
  }
}
