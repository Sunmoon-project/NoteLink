// 진짜 MongoDB에서 공통 알림(NotificationService)과 알림함 · 친구 알림(FR-15-04)을 확인하는 테스트.
// 확인하는 것: 알림함 저장 + 푸시, 만료 토큰 삭제, 종류별 끄기 · 조용한 시간 · 채팅 방 음소거, 푸시가 실패해도 던지지 않음,
// 탈퇴한 사람 제외, 알림함 목록(커서) · 읽지 않은 수 · 읽음 · 모두 읽음(남의 알림은 못 건드림), 친구 요청 · 수락 알림.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다. ExpoPushService는 가짜다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27167/?directConnection=true" npm run test -w @notelink/api -- test/notifications-real-db.test.ts
import { NotFoundException } from '@nestjs/common';
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../src/modules/calendar/schemas/timetable-share.schema.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import {
  Notification,
  NotificationSchema,
} from '../src/modules/notification/schemas/notification.schema.js';
import { FriendsService } from '../src/modules/social/friends/friends.service.js';
import {
  FriendSharedItem,
  FriendSharedItemSchema,
} from '../src/modules/social/schemas/friend-shared-item.schema.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_notify_${process.pid}_${Date.now()}`;

// 서울 12:00
const NOON = new Date('2026-11-19T03:00:00Z');
const token = (n: string) => `ExponentPushToken[${n}]`;

type Sent = { to: string; title: string; body: string; data: Record<string, unknown> };
type SendResult = { invalidTokens: string[]; failedTickets: { message: Sent; error: string }[] };

describe.skipIf(!isLocal)('진짜 DB 공통 알림 · 알림함 · 친구 알림', () => {
  let conn: Connection;
  let users: Model<User>;
  let devices: Model<Device>;
  let notifications: Model<Notification>;
  let friendships: Model<Friendship>;
  let shares: Model<TimetableShare>;
  let sent: Sent[];
  let sendImpl: (messages: Sent[]) => Promise<SendResult>;
  let service: NotificationService;
  let friends: FriendsService;
  const ok: SendResult = { invalidTokens: [], failedTickets: [] };

  const me = new Types.ObjectId();
  const you = new Types.ObjectId();

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    users = conn.model(User.name, UserSchema) as unknown as Model<User>;
    devices = conn.model(Device.name, DeviceSchema) as unknown as Model<Device>;
    notifications = conn.model(
      Notification.name,
      NotificationSchema,
    ) as unknown as Model<Notification>;
    friendships = conn.model(Friendship.name, FriendshipSchema) as unknown as Model<Friendship>;
    shares = conn.model(
      TimetableShare.name,
      TimetableShareSchema,
    ) as unknown as Model<TimetableShare>;
    await Promise.all([
      users.syncIndexes(),
      devices.syncIndexes(),
      notifications.syncIndexes(),
      friendships.syncIndexes(),
    ]);
    const push = {
      send: (messages: Sent[]) => {
        sent.push(...messages);
        return sendImpl(messages);
      },
    };
    service = new NotificationService(
      notifications as never,
      users as never,
      devices as never,
      push as never,
    );
    friends = new FriendsService(
      friendships as never,
      users as never,
      shares as never,
      service,
      conn.model(FriendSharedItem.name, FriendSharedItemSchema) as never,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    sent = [];
    sendImpl = () => Promise.resolve(ok);
    await Promise.all([
      users.deleteMany({}),
      devices.deleteMany({}),
      notifications.deleteMany({}),
      friendships.deleteMany({}),
    ]);
    await users.create([
      { _id: me, nickname: '나나', email: null },
      { _id: you, nickname: '너너', email: null },
    ]);
    await devices.create([
      { userId: you, platform: 'ios', pushToken: token('you1'), locale: 'ko-KR', lastSeenAt: NOON },
      {
        userId: you,
        platform: 'android',
        pushToken: token('you2'),
        locale: 'ko-KR',
        lastSeenAt: NOON,
      },
      { userId: me, platform: 'ios', pushToken: token('me'), locale: 'ko-KR', lastSeenAt: NOON },
    ]);
  });

  const base = {
    category: 'friend' as const,
    type: 'friend-request',
    title: '친구 요청',
    body: '나나님이 친구 요청을 보냈어요',
    data: { requestId: 'r1' },
    collapseId: 'friend-req:r1',
  };
  const inbox = (userId: Types.ObjectId) => notifications.find({ userId }).lean();

  it('알림함에 저장하고 그 사람의 기기마다 푸시한다(data에 type이 들어간다)', async () => {
    await service.notify({ ...base, userIds: [you] }, NOON);
    const rows = await inbox(you);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'friend-request', title: '친구 요청', readAt: null });
    expect(rows[0]!.data).toMatchObject({ requestId: 'r1' });
    expect(sent.map((m) => m.to).sort()).toEqual([token('you1'), token('you2')]);
    expect(sent[0]!.data).toMatchObject({
      type: 'friend-request',
      requestId: 'r1',
      notificationId: String(rows[0]!._id),
    });
    expect(await inbox(me)).toHaveLength(0);
  });

  it('만료된 토큰(DeviceNotRegistered)은 기기 목록에서 지운다', async () => {
    sendImpl = () => Promise.resolve({ invalidTokens: [token('you2')], failedTickets: [] });
    await service.notify({ ...base, userIds: [you] }, NOON);
    expect((await devices.find({ userId: you }).lean()).map((d) => d.pushToken)).toEqual([
      token('you1'),
    ]);
  });

  it('그 종류를 끈 사람에게는 저장도 푸시도 하지 않는다', async () => {
    await users.updateOne({ _id: you }, { $set: { 'settings.notifyFriend': false } });
    await service.notify({ ...base, userIds: [you, me] }, NOON);
    expect(await inbox(you)).toHaveLength(0);
    expect(await inbox(me)).toHaveLength(1);
    expect(sent.map((m) => m.to)).toEqual([token('me')]);
  });

  it('조용한 시간에는 알림함에만 남기고 푸시는 보내지 않는다(자정을 넘는 구간)', async () => {
    await users.updateOne(
      { _id: you },
      { $set: { 'settings.quietHours': { start: '23:00', end: '07:00' } } },
    );
    const lateNight = new Date('2026-11-19T15:30:00Z'); // 서울 00:30
    await service.notify({ ...base, userIds: [you] }, lateNight);
    expect(await inbox(you)).toHaveLength(1);
    expect(sent).toHaveLength(0);
    // 낮에는 보낸다
    await service.notify({ ...base, userIds: [you] }, NOON);
    expect(sent).toHaveLength(2);
  });

  it('음소거한 채팅방의 채팅 알림은 보내지 않고, 다른 방은 보낸다', async () => {
    const room = new Types.ObjectId().toHexString();
    await users.updateOne({ _id: you }, { $set: { 'settings.mutedChatRoomIds': [room] } });
    const chat = { ...base, category: 'chat' as const, type: 'chat-message', inbox: false };
    await service.notify({ ...chat, userIds: [you], data: { chatRoomId: room } }, NOON);
    expect(sent).toHaveLength(0);
    // ObjectId로 넘겨도 음소거를 알아본다
    await service.notify(
      { ...chat, userIds: [you], data: { chatRoomId: new Types.ObjectId(room) } },
      NOON,
    );
    expect(sent).toHaveLength(0);
    await service.notify({ ...chat, userIds: [you], data: { chatRoomId: 'other' } }, NOON);
    expect(sent).toHaveLength(2);
    // inbox: false면 알림함에 남기지 않는다
    expect(await inbox(you)).toHaveLength(0);
  });

  it('푸시 발송이 실패해도 던지지 않고 알림함은 남는다', async () => {
    sendImpl = () => Promise.reject(new Error('network'));
    await expect(service.notify({ ...base, userIds: [you] }, NOON)).resolves.toBeUndefined();
    expect(await inbox(you)).toHaveLength(1);
  });

  it('essential 알림은 종류를 꺼도 · 조용한 시간이어도 간다', async () => {
    await users.updateOne(
      { _id: you },
      {
        $set: {
          'settings.notifyFriend': false,
          'settings.quietHours': { start: '11:00', end: '13:00' },
        },
      },
    );
    await service.notify({ ...base, userIds: [you], essential: true }, NOON);
    expect(await inbox(you)).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });

  it('pushAllowed: 종류를 끈 사람 · 조용한 시간인 사람 · 탈퇴한 사람을 뺀다(자기 방식으로 푸시하는 곳용)', async () => {
    const third = new Types.ObjectId();
    await users.create({ _id: third, nickname: '다다', email: null, deletedAt: NOON });
    await users.updateOne({ _id: you }, { $set: { 'settings.notifyStudy': false } });
    expect((await service.pushAllowed([me, you, third], 'study', NOON)).map(String)).toEqual([
      String(me),
    ]);
    await users.updateOne(
      { _id: me },
      { $set: { 'settings.quietHours': { start: '11:00', end: '13:00' } } },
    );
    expect(await service.pushAllowed([me], 'study', NOON)).toEqual([]);
  });

  it('탈퇴한 사람은 건너뛴다', async () => {
    await users.updateOne({ _id: you }, { $set: { deletedAt: NOON } });
    await service.notify({ ...base, userIds: [you] }, NOON);
    expect(await inbox(you)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('알림함: 최근 것부터 커서로 나눠 읽고, 읽지 않은 수 · 읽음 · 모두 읽음은 내 알림만 바꾼다', async () => {
    for (let i = 0; i < 3; i++)
      await service.notify({ ...base, title: `t${i}`, collapseId: `c${i}`, userIds: [you] }, NOON);
    await service.notify({ ...base, userIds: [me] }, NOON);

    const first = await service.list(you.toHexString(), { limit: 2 });
    expect(first.items.map((n) => n.title)).toEqual(['t2', 't1']);
    expect(first.nextCursor).toBe(first.items[1]!._id);
    const second = await service.list(you.toHexString(), { limit: 2, before: first.nextCursor! });
    expect(second.items.map((n) => n.title)).toEqual(['t0']);
    expect(second.nextCursor).toBeNull();
    expect(first.items[0]).toMatchObject({ type: 'friend-request', readAt: null });
    expect(typeof first.items[0]!.createdAt).toBe('string');

    expect(await service.unreadCount(you.toHexString())).toBe(3);
    // 남의 알림 읽음 처리는 404
    const mine = (await inbox(me))[0]!;
    await expect(service.markRead(you.toHexString(), String(mine._id), NOON)).rejects.toThrow();
    await service.markRead(you.toHexString(), first.items[0]!._id, NOON);
    expect(await service.unreadCount(you.toHexString())).toBe(2);
    await service.markAllRead(you.toHexString(), NOON);
    expect(await service.unreadCount(you.toHexString())).toBe(0);
    expect(await service.unreadCount(me.toHexString())).toBe(1);
  });

  it('알림 삭제: 내 알림만 지우고, 남의 알림 · 없는 알림 · 잘못된 id는 404', async () => {
    await service.notify({ ...base, userIds: [you] }, NOON);
    await service.notify({ ...base, collapseId: 'other', userIds: [me] }, NOON);
    const [yours] = (await service.list(you.toHexString(), {})).items;
    const mine = (await inbox(me))[0]!;
    await expect(service.remove(you.toHexString(), String(mine._id))).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.remove(you.toHexString(), 'nope')).rejects.toThrow(NotFoundException);
    await service.remove(you.toHexString(), yours!._id);
    expect((await service.list(you.toHexString(), {})).items).toHaveLength(0);
    await expect(service.remove(you.toHexString(), yours!._id)).rejects.toThrow(NotFoundException);
    expect(await inbox(me)).toHaveLength(1);
  });

  it('친구 요청을 보내면 받는 사람에게 알림이 간다(거절 뒤 다시 요청해도)', async () => {
    await friends.request(me.toHexString(), you.toHexString(), NOON);
    let rows = await inbox(you);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'friend-request',
      body: '나나님이 친구 요청을 보냈어요',
    });
    const request = await friendships.findOne({}).lean();
    expect(rows[0]!.data).toMatchObject({ requestId: String(request!._id) });

    // 같은 요청을 두 번 눌러도 알림은 하나
    await friends.request(me.toHexString(), you.toHexString(), NOON);
    expect(await inbox(you)).toHaveLength(1);

    await friends.respond(you.toHexString(), String(request!._id), false, NOON);
    expect(await inbox(me)).toHaveLength(0); // 거절은 알리지 않는다
    await friends.request(me.toHexString(), you.toHexString(), NOON);
    rows = await inbox(you);
    // 같은 요청(collapseId)의 알림은 알림함에서 새것 하나로 바뀐다(거절 뒤 되풀이해도 쌓이지 않는다)
    expect(rows).toHaveLength(1);
    expect(rows[0]!.readAt).toBeNull();
  });

  it('요청을 수락하면 보낸 사람에게 알림이 간다', async () => {
    await friends.request(me.toHexString(), you.toHexString(), NOON);
    const request = await friendships.findOne({}).lean();
    await friends.respond(you.toHexString(), String(request!._id), true, NOON);
    const rows = await inbox(me);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'friend-accepted', body: '너너님과 친구가 되었어요' });
  });

  it('상대가 먼저 보낸 요청이 있는 채로 내가 요청하면(서로 요청) 상대에게 수락 알림이 간다', async () => {
    await friends.request(you.toHexString(), me.toHexString(), NOON);
    await friends.request(me.toHexString(), you.toHexString(), NOON);
    const rows = await inbox(you);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'friend-accepted', body: '나나님과 친구가 되었어요' });
  });
});
