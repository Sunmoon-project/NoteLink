// 진짜 MongoDB에서 시간표 공유 알림 · D-day 리마인드(#560 PR 3)를 확인하는 테스트.
// 확인하는 것: 시간표를 새로 공유하거나 공개 방식을 바꾼 친구에게만 알림, D-day는 D-7 · D-1 · 당일 아침(서울 08~10시)에 한 번씩,
// 서버 둘이 같은 순간 돌아도 한 번, 끝낸 D-day · 그 밖의 날 · 발송 시간 밖은 제외, 공부 알림을 끈 사람은 제외.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 전용 DB를 만들고 끝나면 지운다. ExpoPushService는 가짜다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27167/?directConnection=true" npm run test -w @notelink/api -- test/calendar-notices-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { DdayRemindersService } from '../src/modules/calendar/dday-reminders.service.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../src/modules/calendar/schemas/timetable-share.schema.js';
import { Timetable, TimetableSchema } from '../src/modules/calendar/schemas/timetable.schema.js';
import { Todo, TodoSchema } from '../src/modules/calendar/schemas/todo.schema.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import {
  Notification,
  NotificationSchema,
} from '../src/modules/notification/schemas/notification.schema.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { TimetableService } from '../src/modules/timetable/timetable.service.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_cal_notice_${process.pid}_${Date.now()}`;

// 서울 2026-11-19 08:30
const MORNING = new Date('2026-11-18T23:30:00Z');
const token = (n: string) => `ExponentPushToken[${n}]`;
type Sent = { to: string; title: string; body: string; data: Record<string, unknown> };

describe.skipIf(!isLocal)('진짜 DB 시간표 공유 알림 · D-day 리마인드', () => {
  let conn: Connection;
  let users: Model<User>;
  let devices: Model<Device>;
  let notifications: Model<Notification>;
  let todos: Model<Todo>;
  let friendships: Model<Friendship>;
  let shares: Model<TimetableShare>;
  let timetables: Model<Timetable>;
  let sent: Sent[];
  let notifier: NotificationService;
  let reminders: DdayRemindersService;
  let timetable: TimetableService;

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
    todos = conn.model(Todo.name, TodoSchema) as unknown as Model<Todo>;
    friendships = conn.model(Friendship.name, FriendshipSchema) as unknown as Model<Friendship>;
    shares = conn.model(
      TimetableShare.name,
      TimetableShareSchema,
    ) as unknown as Model<TimetableShare>;
    timetables = conn.model(Timetable.name, TimetableSchema) as unknown as Model<Timetable>;
    await Promise.all(
      [devices, notifications, todos, friendships, shares].map((m) =>
        (m as Model<unknown>).syncIndexes(),
      ),
    );
    const push = {
      send: (messages: Sent[]) => {
        sent.push(...messages);
        return Promise.resolve({ invalidTokens: [], failedTickets: [] });
      },
    };
    notifier = new NotificationService(
      notifications as never,
      users as never,
      devices as never,
      push as never,
    );
    reminders = new DdayRemindersService(todos as never, notifier);
    timetable = new TimetableService(
      timetables as never,
      shares as never,
      friendships as never,
      users as never,
      notifier,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    sent = [];
    await Promise.all(
      [users, devices, notifications, todos, friendships, shares].map((m) =>
        (m as Model<unknown>).deleteMany({}),
      ),
    );
    await users.create([
      { _id: me, nickname: '나나', email: null },
      { _id: you, nickname: '너너', email: null },
    ]);
    await devices.create([
      { userId: me, platform: 'ios', pushToken: token('me'), locale: 'ko-KR', lastSeenAt: MORNING },
      {
        userId: you,
        platform: 'ios',
        pushToken: token('you'),
        locale: 'ko-KR',
        lastSeenAt: MORNING,
      },
    ]);
  });

  describe('시간표 공유', () => {
    beforeEach(async () => {
      const [userA, userB] = [me, you].sort((x, y) =>
        x.toHexString().localeCompare(y.toHexString()),
      );
      await friendships.create({
        userA,
        userB,
        requesterId: me,
        status: 'accepted',
        requestedAt: MORNING,
        acceptedAt: MORNING,
      });
    });

    it('새로 공유하면 친구에게, 같은 방식으로 다시 누르면 없음, 방식을 바꾸면 다시 알린다', async () => {
      await timetable.share(me.toHexString(), { friendIds: [you.toHexString()], mode: 'full' });
      // 공유 응답은 알림을 기다리지 않는다
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      let rows = await notifications.find({ userId: you }).lean();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'timetable-shared',
        body: '나나님이 시간표를 공유했어요',
      });
      expect(rows[0]!.data).toMatchObject({ userId: me.toHexString() });

      sent = [];
      await timetable.share(me.toHexString(), { friendIds: [you.toHexString()], mode: 'full' });
      await new Promise((r) => setTimeout(r, 100));
      expect(sent).toHaveLength(0);

      await timetable.share(me.toHexString(), {
        friendIds: [you.toHexString()],
        mode: 'free_only',
      });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      rows = await notifications.find({ userId: you }).lean();
      expect(rows).toHaveLength(1); // 같은 친구 · 같은 사람의 공유 알림은 새것으로 바뀐다
      expect(rows[0]!.body).toBe('나나님이 빈 시간을 공유했어요');
    });

    it('끊긴 예전 관계에서 남은 공유는 없던 것으로 보고, 같은 방식이어도 새 공유로 알린다', async () => {
      await shares.create({
        ownerId: me,
        friendId: you,
        mode: 'full',
        sharedAt: MORNING,
        friendshipId: new Types.ObjectId(), // 이미 끊긴 관계
      });
      await timetable.share(me.toHexString(), { friendIds: [you.toHexString()], mode: 'full' });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
    });

    it('친구 알림을 끈 사람에게는 시간표 공유 알림을 저장 · 푸시하지 않는다', async () => {
      await users.updateOne({ _id: you }, { $set: { 'settings.notifyFriend': false } });
      await timetable.share(me.toHexString(), { friendIds: [you.toHexString()], mode: 'full' });
      await new Promise((r) => setTimeout(r, 100));
      expect(sent).toHaveLength(0);
      expect(await notifications.countDocuments()).toBe(0);
    });
  });

  describe('D-day 리마인드', () => {
    const dday = (dueDate: string, extra: Record<string, unknown> = {}) =>
      todos.create({
        userId: me,
        dueDate,
        content: '토익 시험',
        todoType: 'exam',
        isDday: true,
        ...extra,
      });

    it('D-7 · D-1 · 당일은 알리고, D-3 · 지난 것 · 끝낸 것 · 할 일 짝(isDday=false)은 알리지 않는다', async () => {
      await dday('2026-11-26');
      await dday('2026-11-20');
      await dday('2026-11-19');
      await dday('2026-11-22');
      await dday('2026-11-18');
      await dday('2026-11-20', { done: true });
      await dday('2026-11-20', { isDday: false });
      await reminders.runOnce(MORNING);
      expect(sent.map((m) => m.title).sort()).toEqual([
        'D-1 · 토익 시험',
        'D-7 · 토익 시험',
        'D-day · 토익 시험',
      ]);
      expect(sent.map((m) => m.body).sort()).toEqual([
        '내일이에요',
        '오늘이에요',
        '일주일 남았어요',
      ]);
      const rows = await notifications.find({ userId: me }).lean();
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ type: 'dday-remind' });
    });

    it('서버 둘이 같은 순간 돌거나 다시 돌아도 그날 한 번만', async () => {
      await dday('2026-11-20');
      await Promise.all([reminders.runOnce(MORNING), reminders.runOnce(MORNING)]);
      await reminders.runOnce(new Date(MORNING.getTime() + 30 * 60_000));
      expect(sent).toHaveLength(1);
    });

    it('발송 시간(서울 08~10시) 밖이면 보내지 않는다', async () => {
      await dday('2026-11-20');
      await reminders.runOnce(new Date('2026-11-18T21:00:00Z')); // 서울 06:00
      await reminders.runOnce(new Date('2026-11-19T02:00:00Z')); // 서울 11:00
      expect(sent).toHaveLength(0);
    });

    it('조용한 시간이면 알림함에만 남기고 푸시는 보내지 않는다', async () => {
      await users.updateOne(
        { _id: me },
        { $set: { 'settings.quietHours': { start: '07:00', end: '09:00' } } },
      );
      await dday('2026-11-20');
      await reminders.runOnce(MORNING);
      expect(sent).toHaveLength(0);
      expect(await notifications.countDocuments({ userId: me })).toBe(1);
    });

    it('공부 알림을 끈 사람에게는 보내지 않는다', async () => {
      await users.updateOne({ _id: me }, { $set: { 'settings.notifyStudy': false } });
      await dday('2026-11-20');
      await reminders.runOnce(MORNING);
      expect(sent).toHaveLength(0);
    });
  });
});
