import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES } from '@notelink/shared';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { Device } from '../users/schemas/device.schema.js';
import { EXPO_PUSH_TOKEN, ExpoPushService, type ExpoPushMessage } from './expo-push.service.js';
import { Notification } from './schemas/notification.schema.js';

/** 알림 종류. 사용자가 설정(users.settings.notify*)에서 종류마다 끌 수 있다 */
export type NotificationCategory = 'friend' | 'chat' | 'room' | 'study' | 'ai';

const SETTING_KEY: Record<NotificationCategory, string> = {
  friend: 'notifyFriend',
  chat: 'notifyChat',
  room: 'notifyRoom',
  study: 'notifyStudy',
  ai: 'notifyAi',
};

export type NotifyInput = {
  userIds: (string | Types.ObjectId)[];
  category: NotificationCategory;
  /** 앱이 화면 이동에 쓰는 값. 푸시 data.type과 알림함 type에 같이 들어간다 */
  type: string;
  title: string;
  body: string;
  /** 화면 이동용 값. 알림을 일으킨 사람이 있으면 `userId`에 그 id를 넣는다(탈퇴하면 그 알림을 지운다 — UsersService.withdraw) */
  data?: Record<string, unknown>;
  /** 같은 값의 푸시는 기기에서 하나로 바뀐다(아이폰 collapseId) */
  collapseId?: string;
  /** 같은 값끼리 알림 센터에서 묶인다. 비우면 type */
  threadId?: string;
  channelId?: string;
  /** false면 알림함에 남기지 않고 푸시만 보낸다(채팅 메시지 — 채팅 목록의 읽지 않은 수로 충분) */
  inbox?: boolean;
  /** true면 종류별 끄기 · 조용한 시간을 무시한다(퇴장 조치처럼 당사자가 꼭 알아야 하는 알림) */
  essential?: boolean;
};

export type InboxItem = {
  _id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
};

type Prefs = {
  _id: Types.ObjectId;
  settings?: {
    quietHours?: { start?: unknown; end?: unknown } | null;
    mutedChatRoomIds?: unknown;
  } & Record<string, unknown>;
};

/** 'HH:mm' → 분. 형식이 아니면 null */
function minutesOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 서울 시각이 조용한 시간 안인지. 23:00~07:00처럼 자정을 넘는 구간도 된다(한국은 서머타임이 없다) */
export function inQuietHours(quiet: unknown, now: Date): boolean {
  const q = quiet as { start?: unknown; end?: unknown } | null | undefined;
  const start = minutesOf(q?.start);
  const end = minutesOf(q?.end);
  if (start === null || end === null || start === end) return false;
  const seoul = new Date(now.getTime() + 9 * 3_600_000);
  const t = seoul.getUTCHours() * 60 + seoul.getUTCMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * 모든 알림의 공통 입구: 설정 확인 → 알림함(notifications) 저장 → Expo 푸시 → 만료 토큰 정리.
 * 알림은 본 동작(친구 요청 · 메시지 저장 등)의 덤이라 어떤 실패도 던지지 않고 기록만 남긴다.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly push: ExpoPushService,
  ) {}

  async notify(input: NotifyInput, now = new Date()): Promise<void> {
    try {
      await this.deliver(input, now);
    } catch (error) {
      this.logger.warn(`알림을 보내지 못했어요(${input.type}): ${String(error)}`);
    }
  }

  private async deliver(input: NotifyInput, now: Date): Promise<void> {
    const targets = this.targetsOf(await this.prefsOf(input.userIds), input);
    if (!targets.length) return;
    // 알림함 id를 푸시 data에 실어 앱이 눌렀을 때 읽음 처리할 수 있게 한다
    const inboxIds =
      input.inbox === false ? new Map<string, string>() : await this.store(targets, input);
    await this.pushTo(targets, inboxIds, input, now);
  }

  /**
   * 알림함에만 남긴다(탈퇴 · 종류를 끈 사람 제외). 남긴 사람 id → 알림 id.
   * 발송 · 재시도를 직접 하는 곳(AI 작업 알림)이 쓰고, 푸시는 pushAllowed로 확인해 따로 보낸다
   */
  async saveToInbox(input: NotifyInput): Promise<Map<string, string>> {
    const targets = this.targetsOf(await this.prefsOf(input.userIds), input);
    return targets.length ? this.store(targets, input) : new Map();
  }

  private targetsOf(people: Prefs[], input: NotifyInput): Prefs[] {
    const chatRoomId = input.data?.chatRoomId == null ? null : String(input.data.chatRoomId);
    return people.filter((p) => {
      const s = p.settings ?? {};
      if (!input.essential && s[SETTING_KEY[input.category]] === false) return false;
      if (input.category === 'chat' && chatRoomId) {
        const muted = Array.isArray(s.mutedChatRoomIds) ? s.mutedChatRoomIds : [];
        if (muted.includes(chatRoomId)) return false;
      }
      return true;
    });
  }

  private async store(targets: Prefs[], input: NotifyInput): Promise<Map<string, string>> {
    const inboxIds = new Map<string, string>();
    // 같은 collapseId의 예전 알림은 새것으로 바꾼다(거절 뒤 다시 요청하기를 되풀이해도 알림함에 쌓이지 않는다)
    // ponytail: 지우기 · 넣기가 원자적이지 않아 같은 순간 두 번 오면 한 줄이 더 남을 수 있다(무해). 문제가 되면 {userId, collapseKey} 부분 유일 인덱스로
    if (input.collapseId)
      await this.notifications.deleteMany({
        userId: { $in: targets.map((p) => p._id) },
        collapseKey: input.collapseId,
      });
    const rows = await this.notifications.insertMany(
      targets.map((p) => ({
        userId: p._id,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data ?? null,
        collapseKey: input.collapseId ?? null,
      })),
    );
    rows.forEach((r) => inboxIds.set(String(r.userId), String(r._id)));
    return inboxIds;
  }

  private async pushTo(
    targets: Prefs[],
    inboxIds: Map<string, string>,
    input: NotifyInput,
    now: Date,
  ): Promise<void> {
    const pushTo = input.essential
      ? targets
      : targets.filter((p) => !inQuietHours(p.settings?.quietHours, now));
    if (!pushTo.length) return;
    const devices = await this.devices
      .find({ userId: { $in: pushTo.map((p) => p._id) } }, { userId: 1, pushToken: 1 })
      .lean<{ userId: Types.ObjectId; pushToken: string }[]>();
    const seen = new Set<string>();
    const messages: ExpoPushMessage[] = [];
    for (const d of devices) {
      if (seen.has(d.pushToken) || !EXPO_PUSH_TOKEN.test(d.pushToken)) continue;
      seen.add(d.pushToken);
      const notificationId = inboxIds.get(String(d.userId));
      messages.push({
        to: d.pushToken,
        title: input.title,
        body: input.body,
        data: { ...input.data, type: input.type, ...(notificationId ? { notificationId } : {}) },
        sound: 'default',
        priority: 'high',
        ...(input.channelId ? { channelId: input.channelId } : {}),
        collapseId: input.collapseId ?? `${input.type}:${notificationId ?? now.getTime()}`,
        threadId: input.threadId ?? input.type,
      });
    }
    if (!messages.length) return;
    // ponytail: 요청 안에서 바로 보낸다(Expo는 100개씩 배치). 방 채팅처럼 받는 사람이 많아 느려지면 큐로 옮긴다
    const result = await this.push.send(messages);
    if (result.invalidTokens.length)
      await this.devices.deleteMany({ pushToken: { $in: result.invalidTokens } });
    for (const { message, error } of result.failedTickets)
      this.logger.warn(`푸시 실패(${input.type}, ${message.to.slice(0, 22)}…): ${error}`);
  }

  /**
   * 지금 이 종류의 푸시를 받을 사람(탈퇴 · 종류 끔 · 조용한 시간 제외). 알림함 없이 자기 방식으로 푸시하는 곳(스터디룸 타이머)이 쓴다
   */
  async pushAllowed(
    userIds: (string | Types.ObjectId)[],
    category: NotificationCategory,
    now = new Date(),
  ): Promise<Types.ObjectId[]> {
    const people = await this.prefsOf(userIds);
    return people
      .filter((p) => p.settings?.[SETTING_KEY[category]] !== false)
      .filter((p) => !inQuietHours(p.settings?.quietHours, now))
      .map((p) => p._id);
  }

  /** 탈퇴하지 않은 사람들의 알림 설정 */
  private prefsOf(userIds: (string | Types.ObjectId)[]): Promise<Prefs[]> {
    const ids = [...new Set(userIds.map(String))]
      .filter((id) => isValidObjectId(id))
      .map((id) => new Types.ObjectId(id));
    if (!ids.length) return Promise.resolve([]);
    return this.users
      .find({ _id: { $in: ids }, deletedAt: null, withdrawingAt: null })
      .select('_id settings')
      .lean<Prefs[]>();
  }

  /** 내 알림함. 최근 것부터, before(알림 id) 이전 것을 limit개 */
  async list(
    userId: string,
    { before, limit = 20 }: { before?: string; limit?: number },
  ): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
    const size = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
    const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
    if (before && isValidObjectId(before)) filter._id = { $lt: new Types.ObjectId(before) };
    const rows = await this.notifications
      .find(filter)
      .sort({ _id: -1 })
      .limit(size + 1)
      .lean<(Notification & { _id: Types.ObjectId; createdAt: Date })[]>();
    const items = rows.slice(0, size).map((r) => ({
      _id: String(r._id),
      type: r.type,
      title: r.title,
      body: r.body,
      data: r.data ?? null,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length > size ? items[items.length - 1]!._id : null };
  }

  unreadCount(userId: string): Promise<number> {
    return this.notifications.countDocuments({ userId: new Types.ObjectId(userId), readAt: null });
  }

  async markRead(userId: string, id: string, now = new Date()): Promise<void> {
    const notFound = () =>
      new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: '알림을 찾을 수 없어요' });
    if (!isValidObjectId(id)) throw notFound();
    const mine = { _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) };
    // 이미 읽은 알림은 처음 읽은 시각을 그대로 둔다
    const updated = await this.notifications.updateOne(
      { ...mine, readAt: null },
      { $set: { readAt: now } },
    );
    if (updated.matchedCount === 0 && !(await this.notifications.exists(mine))) throw notFound();
  }

  async markAllRead(userId: string, now = new Date()): Promise<void> {
    await this.notifications.updateMany(
      { userId: new Types.ObjectId(userId), readAt: null },
      { $set: { readAt: now } },
    );
  }
}
