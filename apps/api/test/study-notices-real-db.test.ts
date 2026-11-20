// 진짜 MongoDB에서 채팅 · 스터디룸 알림(#560 PR 2)을 확인하는 테스트.
// 확인하는 것: 1:1 · 방 채팅은 그 채팅을 보고 있지 않은(소켓으로 받지 않은) 멤버에게만 푸시하고 알림함에는 남기지 않음,
// 같은 방은 하나로 묶음(collapseId · threadId), 사진 · 파일 문구, 방별 음소거, 초대 카드는 방 활동 알림(알림함 포함),
// 퇴장 조치는 방 활동을 꺼도 감(essential), 방 공유 자료는 새로 공유된 노트가 있을 때만 다른 멤버에게,
// 스터디룸 타이머 푸시는 방 활동을 끈 사람을 뺀다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 전용 DB를 만들고 끝나면 지운다. ExpoPushService는 가짜다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27167/?directConnection=true" npm run test -w @notelink/api -- test/study-notices-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { MaterialSharingService } from '../src/modules/content/materials/material-sharing.service.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import {
  Notification,
  NotificationSchema,
} from '../src/modules/notification/schemas/notification.schema.js';
import { ChatRoom, ChatRoomSchema } from '../src/modules/social/schemas/chat-room.schema.js';
import {
  RoomSharedItem,
  RoomSharedItemSchema,
} from '../src/modules/studyroom/schemas/room-shared-item.schema.js';
import { Flashcard, FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyRoomNoticesService } from '../src/modules/studyroom/study-room-notices.service.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_study_notice_${process.pid}_${Date.now()}`;

const NOON = new Date('2026-11-19T03:00:00Z');
const token = (n: string) => `ExponentPushToken[${n}]`;
type Sent = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  collapseId: string;
  threadId: string;
};

describe.skipIf(!isLocal)('진짜 DB 채팅 · 스터디룸 알림', () => {
  let conn: Connection;
  let users: Model<User>;
  let devices: Model<Device>;
  let notifications: Model<Notification>;
  let chats: Model<ChatRoom>;
  let rooms: Model<StudyRoom>;
  let materials: Model<Material>;
  let items: Model<RoomSharedItem>;
  let sent: Sent[];
  let notices: StudyRoomNoticesService;
  let sharing: MaterialSharingService;
  let notifier: NotificationService;

  const a = new Types.ObjectId();
  const b = new Types.ObjectId();
  const c = new Types.ObjectId();
  const dmId = new Types.ObjectId();
  const roomId = new Types.ObjectId();
  const roomChatId = new Types.ObjectId();

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    users = conn.model(User.name, UserSchema) as unknown as Model<User>;
    devices = conn.model(Device.name, DeviceSchema) as unknown as Model<Device>;
    notifications = conn.model(
      Notification.name,
      NotificationSchema,
    ) as unknown as Model<Notification>;
    chats = conn.model(ChatRoom.name, ChatRoomSchema) as unknown as Model<ChatRoom>;
    rooms = conn.model(StudyRoom.name, StudyRoomSchema) as unknown as Model<StudyRoom>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    items = conn.model(
      RoomSharedItem.name,
      RoomSharedItemSchema,
    ) as unknown as Model<RoomSharedItem>;
    await Promise.all([devices.syncIndexes(), notifications.syncIndexes(), items.syncIndexes()]);
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
    notices = new StudyRoomNoticesService(chats as never, rooms as never, notifier);
    sharing = new MaterialSharingService(
      materials as never,
      rooms as never,
      items as never,
      users as never,
      conn.model(QuizSet.name, QuizSetSchema) as never,
      conn.model(Flashcard.name, FlashcardSchema) as never,
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
      [users, devices, notifications, chats, rooms, materials, items].map((m) =>
        (m as Model<unknown>).deleteMany({}),
      ),
    );
    await users.create([
      { _id: a, nickname: '가가', email: null },
      { _id: b, nickname: '나나', email: null },
      { _id: c, nickname: '다다', email: null },
    ]);
    await devices.create(
      [a, b, c].map((userId, i) => ({
        userId,
        platform: 'ios',
        pushToken: token(`u${i}`),
        locale: 'ko-KR',
        lastSeenAt: NOON,
      })),
    );
    const member = (userId: Types.ObjectId) => ({ userId, joinedAt: NOON });
    await chats.collection.insertMany([
      { _id: dmId, type: 'direct', directKey: 'ab', members: [member(a), member(b)] },
      { _id: roomChatId, type: 'study_room', studyRoomId: roomId, members: [] },
    ]);
    await rooms.collection.insertOne({
      _id: roomId,
      title: '토익 스터디',
      hostId: a,
      closedAt: null,
      memberCount: 3,
      members: [
        { userId: a, role: 'host', status: 'joined' },
        { userId: b, role: 'member', status: 'joined' },
        { userId: c, role: 'member', status: 'joined' },
      ],
    });
  });

  const tokensOf = () => sent.map((m) => m.to).sort();
  const text = (chatRoomId: Types.ObjectId, from: Types.ObjectId, body: string) => ({
    _id: String(new Types.ObjectId()),
    chatRoomId: String(chatRoomId),
    senderId: String(from),
    senderNickname: from.equals(a) ? '가가' : '나나',
    type: 'text',
    text: body,
  });

  it('1:1 채팅: 상대에게 보낸 사람 이름 · 메시지로 푸시하고 같은 채팅은 하나로 묶는다(알림함 없음)', async () => {
    await notices.chatMessage(text(dmId, a, '안녕'), []);
    expect(tokensOf()).toEqual([token('u1')]);
    expect(sent[0]).toMatchObject({
      title: '가가',
      body: '안녕',
      collapseId: `chat:${dmId.toHexString()}`,
      threadId: `chat:${dmId.toHexString()}`,
    });
    expect(sent[0]!.data).toMatchObject({
      type: 'chat-message',
      chatRoomId: dmId.toHexString(),
      userId: a.toHexString(),
    });
    expect(await notifications.countDocuments()).toBe(0);
  });

  it('그 채팅을 보고 있는(소켓으로 이미 받은) 사람에게는 푸시하지 않는다', async () => {
    await notices.chatMessage(text(dmId, a, '안녕'), [b.toHexString()]);
    expect(sent).toHaveLength(0);
  });

  it('긴 글은 줄이고, 사진 · 파일은 문구로 바꾼다', async () => {
    await notices.chatMessage(text(dmId, a, '가'.repeat(200)), []);
    expect(sent[0]!.body).toHaveLength(80);
    expect(sent[0]!.body.endsWith('…')).toBe(true);
    await notices.chatMessage({ ...text(dmId, a, ''), type: 'image', text: null }, []);
    expect(sent[1]!.body).toBe('사진을 보냈어요');
    await notices.chatMessage({ ...text(dmId, a, ''), type: 'file', text: null }, []);
    expect(sent[2]!.body).toBe('파일을 보냈어요');
  });

  it('스터디룸 채팅: 방 이름 · 「닉네임: 메시지」로, 보낸 사람과 방을 보고 있는 사람을 뺀 멤버에게', async () => {
    await notices.chatMessage(text(roomChatId, a, '오늘 몇 시?'), [c.toHexString()]);
    expect(tokensOf()).toEqual([token('u1')]);
    expect(sent[0]).toMatchObject({ title: '토익 스터디', body: '가가: 오늘 몇 시?' });
    expect(sent[0]!.data).toMatchObject({ roomId: roomId.toHexString() });
  });

  it('방 채팅을 음소거한 사람 · 채팅 알림을 끈 사람은 뺀다', async () => {
    await users.updateOne(
      { _id: b },
      { $set: { 'settings.mutedChatRoomIds': [roomChatId.toHexString()] } },
    );
    await users.updateOne({ _id: c }, { $set: { 'settings.notifyChat': false } });
    await notices.chatMessage(text(roomChatId, a, '안녕'), []);
    expect(sent).toHaveLength(0);
  });

  it('나간 멤버 · 1:1에서 나간 사람에게는 보내지 않는다', async () => {
    await rooms.updateOne({ _id: roomId }, { $set: { 'members.1.status': 'left' } });
    await notices.chatMessage(text(roomChatId, a, '안녕'), []);
    expect(tokensOf()).toEqual([token('u2')]);
    sent = [];
    await chats.updateOne({ _id: dmId }, { $set: { 'members.1.leftAt': NOON } });
    await notices.chatMessage(text(dmId, a, '안녕'), []);
    expect(sent).toHaveLength(0);
  });

  it('스터디룸 초대 카드는 방 활동 알림으로 알림함에도 남는다(보고 있어도)', async () => {
    await notices.chatMessage(
      {
        ...text(dmId, a, '토익 스터디 스터디룸에 초대했어요.'),
        type: 'study_room_invite',
        studyRoomInvite: { roomId: roomId.toHexString(), title: '토익 스터디', inviteCode: 'X' },
      },
      [b.toHexString()],
    );
    const rows = await notifications.find({ userId: b }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'room-invite',
      body: '가가님이 「토익 스터디」 스터디룸에 초대했어요',
    });
    expect(rows[0]!.data).toMatchObject({ roomId: roomId.toHexString(), userId: a.toHexString() });
    // 방 활동을 끄면 오지 않는다
    await notifications.deleteMany({});
    await users.updateOne({ _id: b }, { $set: { 'settings.notifyRoom': false } });
    await notices.chatMessage(
      {
        ...text(dmId, a, 'x'),
        type: 'study_room_invite',
        studyRoomInvite: { roomId: 'r', title: 't' },
      },
      [],
    );
    expect(await notifications.countDocuments()).toBe(0);
  });

  it('퇴장 조치는 방 활동을 꺼도 · 조용한 시간이어도 당사자에게 간다', async () => {
    await users.updateOne(
      { _id: b },
      {
        $set: {
          'settings.notifyRoom': false,
          'settings.quietHours': { start: '11:00', end: '13:00' },
        },
      },
    );
    await notices.kicked(roomId.toHexString(), b.toHexString(), NOON);
    const rows = await notifications.find({ userId: b }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'room-kicked',
      body: '「토익 스터디」에서 내보내졌어요',
    });
    expect(tokensOf()).toEqual([token('u1')]);
  });

  it('방 공유 자료: 새로 공유된 노트가 있을 때만 다른 멤버에게 알린다', async () => {
    const note = new Types.ObjectId();
    await materials.collection.insertOne({
      _id: note,
      ownerId: a,
      folderId: new Types.ObjectId(),
      deletedAt: null,
      title: '단어장',
    });
    const dto = {
      materialIds: [note.toHexString()],
      target: { type: 'room', id: roomId.toHexString() },
    };
    await sharing.share(a.toHexString(), dto as never);
    // 공유 응답은 알림을 기다리지 않는다
    await vi.waitFor(async () => expect(await notifications.countDocuments()).toBe(2));
    const rows = await notifications.find({}).lean();
    expect(rows.map((r) => String(r.userId)).sort()).toEqual([String(b), String(c)].sort());
    expect(rows[0]).toMatchObject({
      type: 'room-shared',
      body: '가가님이 「토익 스터디」에 노트 1개를 공유했어요',
    });
    // 같은 노트를 다시 공유하면(새로 들어간 것이 없으면) 알리지 않는다
    sent = [];
    await sharing.share(a.toHexString(), dto as never);
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(0);
  });

  it('타이머 푸시 대상: 방 활동을 끈 사람 · 조용한 시간인 사람은 뺀다', async () => {
    await users.updateOne({ _id: b }, { $set: { 'settings.notifyRoom': false } });
    await users.updateOne(
      { _id: c },
      { $set: { 'settings.quietHours': { start: '11:00', end: '13:00' } } },
    );
    const allowed = await notifier.pushAllowed([a, b, c], 'room', NOON);
    expect(allowed.map(String)).toEqual([String(a)]);
  });
});
