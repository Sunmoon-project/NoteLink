import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const RETRY_MAX_ATTEMPTS = 5;
const EXPO_PUSH_TOKEN = /^(?:Expo|Exponent)PushToken\[[^\]]+\]$/;

type TimerPhase = 'focus' | 'break' | 'period' | 'completed';
type PendingTimerNotification = {
  transitionAt: Date;
  phase: TimerPhase;
  title: string;
  body: string;
};
type TimerNotificationRetry = PendingTimerNotification & {
  eventId: string;
  timerRevision: number;
  recipients: { userId: string; token: string }[];
  attempts: number;
  nextAttemptAt: Date;
};
type TimerLeaseField = 'timerPendingLeaseUntil' | 'timerNotificationRetryLeaseUntil';
type TimerLeaseHeartbeat = { stop: () => Promise<void> };
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
      await this.retryFailedNotifications(now);
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

    const heartbeat = this.startLeaseHeartbeat(
      id,
      revision,
      'timerPendingLeaseUntil',
      new Date(leaseAcquiredAt.getTime() + PUSH_LEASE_MS),
    );

    try {
      const room = await this.rooms
        .findOne({ _id: id, closedAt: null, timerRevision: revision })
        .lean();
      const pending = room?.timerPendingNotification as PendingTimerNotification | null | undefined;
      if (!room || !pending) return;

      const joinedUserIds = room.members
        .filter((member) => member.status === 'joined')
        .map((member) => member.userId);
      if (!joinedUserIds.length) {
        await this.clearPending(id, revision, pending.transitionAt);
        return;
      }

      const devices = await this.devices
        .find({ userId: { $in: joinedUserIds } }, { userId: 1, pushToken: 1 })
        .lean();
      const tokens = devices
        .map((device) => device.pushToken)
        .filter((token) => EXPO_PUSH_TOKEN.test(token));
      if (!tokens.length) {
        await this.clearPending(id, revision, pending.transitionAt);
        return;
      }

      const eventId = `${roomId}:${pending.transitionAt.toISOString()}`;
      const deviceByToken = new Map(
        devices.map((device) => [device.pushToken, String(device.userId)]),
      );
      const messages = tokens.map((to) => this.pushMessage(roomId, eventId, pending, to));
      const result = await this.push.send(messages);
      if (result.invalidTokens.length)
        await this.devices.deleteMany({ pushToken: { $in: result.invalidTokens } });
      if (result.failedTickets.length) {
        const failedTokenOwners = new Map<string, string>();
        for (const { message } of result.failedTickets) {
          const userId = deviceByToken.get(message.to);
          if (userId) failedTokenOwners.set(message.to, userId);
        }
        const failedRecipients = [...failedTokenOwners].map(([token, userId]) => ({
          token,
          userId,
        }));
        if (failedRecipients.length) {
          await this.rooms.updateOne(
            {
              _id: id,
              timerRevision: revision,
              'timerPendingNotification.transitionAt': pending.transitionAt,
            },
            {
              $push: {
                timerNotificationRetries: {
                  eventId,
                  transitionAt: pending.transitionAt,
                  phase: pending.phase,
                  title: pending.title,
                  body: pending.body,
                  timerRevision: revision,
                  recipients: failedRecipients,
                  attempts: 0,
                  nextAttemptAt: new Date(Date.now() + RETRY_BASE_MS),
                },
              },
            },
          );
          this.logger.warn(
            `일부 스터디룸 타이머 푸시를 수신자별 재시도 큐에 보관했습니다 (${failedRecipients.length})`,
          );
        }
      }
      await this.clearPending(id, revision, pending.transitionAt);
    } catch (error) {
      this.logger.warn(`스터디룸 타이머 푸시 전송을 재시도합니다: ${String(error)}`);
    } finally {
      await heartbeat.stop();
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

  private pushMessage(
    roomId: string,
    eventId: string,
    notification: PendingTimerNotification,
    to: string,
  ): ExpoPushMessage {
    return {
      to,
      title: notification.title,
      body: notification.body,
      data: {
        type: 'study-room-timer',
        roomId,
        phase: notification.phase,
        transitionId: eventId,
      },
      sound: 'default',
      priority: 'high',
      channelId: 'study-room-timer',
      collapseId: eventId,
      threadId: `study-room-${roomId}`,
    };
  }

  private async retryFailedNotifications(now: Date): Promise<void> {
    const leaseCheckAt = new Date();
    const rooms = await this.rooms
      .find(
        {
          closedAt: null,
          timerNotificationRetries: {
            $elemMatch: {
              nextAttemptAt: { $lte: now },
              attempts: { $lt: RETRY_MAX_ATTEMPTS },
            },
          },
          $or: [
            { timerNotificationRetryLeaseUntil: null },
            { timerNotificationRetryLeaseUntil: { $lte: leaseCheckAt } },
          ],
        },
        { _id: 1, timerRevision: 1 },
      )
      .limit(TIMER_SCAN_LIMIT)
      .lean();

    for (const room of rooms)
      await this.retryRoomNotifications(String(room._id), room.timerRevision ?? 0, now);
  }

  private async retryRoomNotifications(roomId: string, revision: number, now: Date): Promise<void> {
    if (!isValidObjectId(roomId)) return;
    const id = new Types.ObjectId(roomId);
    const leaseAcquiredAt = new Date();
    const initialLeaseUntil = new Date(leaseAcquiredAt.getTime() + PUSH_LEASE_MS);
    const leaseOwnerToken = randomUUID();
    const dueFilter = {
      nextAttemptAt: { $lte: now },
      attempts: { $lt: RETRY_MAX_ATTEMPTS },
      timerRevision: revision,
    };
    const claimed = await this.rooms.updateOne(
      {
        _id: id,
        closedAt: null,
        timerRevision: revision,
        timerNotificationRetries: { $elemMatch: dueFilter },
        $or: [
          { timerNotificationRetryLeaseUntil: null },
          { timerNotificationRetryLeaseUntil: { $lte: leaseAcquiredAt } },
        ],
      },
      {
        $set: {
          timerNotificationRetryLeaseUntil: initialLeaseUntil,
          timerNotificationRetryLeaseToken: leaseOwnerToken,
        },
      },
    );
    if (!claimed.matchedCount) return;
    const heartbeat = this.startLeaseHeartbeat(
      id,
      revision,
      'timerNotificationRetryLeaseUntil',
      initialLeaseUntil,
      leaseOwnerToken,
    );

    try {
      const room = await this.rooms
        .findOne({ _id: id, closedAt: null, timerRevision: revision })
        .lean();
      if (!room) return;
      const retries = (room.timerNotificationRetries ?? []) as unknown as TimerNotificationRetry[];
      const due = retries.filter(
        (retry) =>
          retry.timerRevision === revision &&
          retry.attempts < RETRY_MAX_ATTEMPTS &&
          new Date(retry.nextAttemptAt).getTime() <= now.getTime(),
      );
      if (!due.length) {
        await heartbeat.stop();
        await this.releaseRetryLease(id, revision, leaseOwnerToken);
        return;
      }

      const joinedMembers = new Map(
        room.members
          .filter((member) => member.status === 'joined')
          .map((member) => [String(member.userId), member.userId]),
      );
      const candidateRecipients = due.flatMap((retry) =>
        retry.recipients.filter((recipient) => joinedMembers.has(recipient.userId)),
      );
      const candidateTokens = [...new Set(candidateRecipients.map(({ token }) => token))];
      const currentDevices =
        candidateTokens.length && joinedMembers.size
          ? await this.devices
              .find(
                {
                  userId: { $in: [...joinedMembers.values()] },
                  pushToken: { $in: candidateTokens },
                },
                { userId: 1, pushToken: 1 },
              )
              .lean()
          : [];
      const currentDeviceKeys = new Set(
        currentDevices.map((device) => `${String(device.userId)}:${device.pushToken}`),
      );
      const eligibleByEvent = new Map<string, { userId: string; token: string }[]>();
      const messages: ExpoPushMessage[] = [];
      for (const retry of due) {
        const eligible = retry.recipients.filter(
          (recipient) =>
            joinedMembers.has(recipient.userId) &&
            currentDeviceKeys.has(`${recipient.userId}:${recipient.token}`),
        );
        eligibleByEvent.set(retry.eventId, eligible);
        messages.push(
          ...eligible.map((recipient) =>
            this.pushMessage(roomId, retry.eventId, retry, recipient.token),
          ),
        );
      }

      const result = messages.length
        ? await this.push.send(messages)
        : { invalidTokens: [], failedTickets: [] };
      if (result.invalidTokens.length)
        await this.devices.deleteMany({ pushToken: { $in: result.invalidTokens } });
      const failedByEvent = new Map<string, Set<string>>();
      for (const { message } of result.failedTickets) {
        const eventId = message.data.transitionId;
        if (typeof eventId !== 'string') continue;
        const failed = failedByEvent.get(eventId) ?? new Set<string>();
        failed.add(message.to);
        failedByEvent.set(eventId, failed);
      }

      let exhausted = 0;
      for (const retry of due) {
        const failedTokens = failedByEvent.get(retry.eventId);
        if (!failedTokens?.size) {
          await this.removeRetry(id, revision, leaseOwnerToken, retry.eventId);
          continue;
        }
        const recipients = (eligibleByEvent.get(retry.eventId) ?? []).filter(({ token }) =>
          failedTokens.has(token),
        );
        if (!recipients.length) {
          await this.removeRetry(id, revision, leaseOwnerToken, retry.eventId);
          continue;
        }
        const attempts = retry.attempts + 1;
        if (attempts >= RETRY_MAX_ATTEMPTS) {
          exhausted += recipients.length;
          await this.removeRetry(id, revision, leaseOwnerToken, retry.eventId);
          continue;
        }
        const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
        await this.rooms.updateOne(
          {
            _id: id,
            closedAt: null,
            timerRevision: revision,
            timerNotificationRetryLeaseToken: leaseOwnerToken,
            timerNotificationRetries: { $elemMatch: { eventId: retry.eventId } },
          },
          {
            $set: {
              'timerNotificationRetries.$[retry].recipients': recipients,
              'timerNotificationRetries.$[retry].attempts': attempts,
              'timerNotificationRetries.$[retry].nextAttemptAt': new Date(Date.now() + delay),
            },
          },
          { arrayFilters: [{ 'retry.eventId': retry.eventId }] },
        );
      }
      if (exhausted)
        this.logger.warn(`스터디룸 타이머 푸시 재시도를 횟수 제한으로 종료했습니다 (${exhausted})`);

      await heartbeat.stop();
      await this.releaseRetryLease(id, revision, leaseOwnerToken);
    } catch (error) {
      this.logger.warn(`스터디룸 타이머 푸시 재시도를 이어서 처리합니다: ${String(error)}`);
      await heartbeat.stop();
      await this.releaseRetryLease(id, revision, leaseOwnerToken);
    } finally {
      await heartbeat.stop();
    }
  }

  private removeRetry(id: Types.ObjectId, revision: number, ownerToken: string, eventId: string) {
    return this.rooms.updateOne(
      {
        _id: id,
        closedAt: null,
        timerRevision: revision,
        timerNotificationRetryLeaseToken: ownerToken,
        timerNotificationRetries: { $elemMatch: { eventId } },
      },
      { $pull: { timerNotificationRetries: { eventId } } },
    );
  }

  private releaseRetryLease(id: Types.ObjectId, revision: number, ownerToken: string) {
    return this.rooms.updateOne(
      {
        _id: id,
        timerRevision: revision,
        timerNotificationRetryLeaseToken: ownerToken,
      },
      {
        $set: {
          timerNotificationRetryLeaseUntil: null,
          timerNotificationRetryLeaseToken: null,
        },
      },
    );
  }

  private startLeaseHeartbeat(
    id: Types.ObjectId,
    revision: number,
    field: TimerLeaseField,
    initialLeaseUntil: Date,
    ownerToken?: string,
  ): TimerLeaseHeartbeat {
    let leaseUntil = initialLeaseUntil;
    let inFlight: Promise<void> | null = null;
    const interval = setInterval(() => {
      if (inFlight) return;
      const nextLeaseUntil = new Date(Date.now() + PUSH_LEASE_MS);
      const filter = ownerToken
        ? { _id: id, timerRevision: revision, timerNotificationRetryLeaseToken: ownerToken }
        : { _id: id, timerRevision: revision, [field]: leaseUntil };
      inFlight = this.rooms
        .updateOne(filter, { $set: { [field]: nextLeaseUntil } })
        .then((updated) => {
          if (updated.matchedCount) leaseUntil = nextLeaseUntil;
          else this.logger.warn('스터디룸 타이머 발송 잠금 갱신에 실패했습니다');
        })
        .catch((error: unknown) => {
          this.logger.warn(`스터디룸 타이머 발송 잠금을 갱신하지 못했습니다: ${String(error)}`);
        })
        .finally(() => {
          inFlight = null;
        });
    }, PUSH_LEASE_MS / 3);
    interval.unref?.();

    return {
      stop: async () => {
        clearInterval(interval);
        await inFlight;
      },
    };
  }

  private logFailure(error: unknown): void {
    this.logger.warn(`스터디룸 타이머 점검을 다시 시도합니다: ${String(error)}`);
  }
}
