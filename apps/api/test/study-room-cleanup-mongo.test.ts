import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChatRoom, ChatRoomSchema } from '../src/modules/social/schemas/chat-room.schema.js';
import { Message, MessageSchema } from '../src/modules/social/schemas/message.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyRoomCleanupService } from '../src/modules/studyroom/study-room-cleanup.service.js';

const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);

describe.skipIf(!local)('스터디룸 만료 정리', () => {
  const suffix = randomBytes(8).toString('hex');
  const names = ['rooms', 'chats', 'messages'].map((name) => `test_cleanup_${name}_${suffix}`);
  let connection: mongoose.Connection;
  let rooms: mongoose.Model<StudyRoom>;
  let chats: mongoose.Model<ChatRoom>;
  let messages: mongoose.Model<Message>;
  let cleanup: StudyRoomCleanupService;

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri!, { serverSelectionTimeoutMS: 5000 })
      .asPromise();
    rooms = connection.model(StudyRoom.name, StudyRoomSchema, names[0]);
    chats = connection.model(ChatRoom.name, ChatRoomSchema, names[1]);
    messages = connection.model(Message.name, MessageSchema, names[2]);
    cleanup = new StudyRoomCleanupService(rooms, chats, messages);
  });
  afterAll(async () => {
    if (!connection) return;
    for (const name of names) await connection.dropCollection(name!).catch(() => {});
    await connection.close();
  });

  it('7일 전에는 보관하고 만료 시 해당 방과 채팅만 삭제하며 재실행해도 안전하다', async () => {
    const host = new Types.ObjectId();
    const closedAt = new Date('2026-01-01T00:00:00Z');
    const deadline = new Date(closedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const room = await rooms.create({
      title: '만료 방',
      categoryId: new Types.ObjectId(),
      hostId: host,
      inviteCode: 'EXP001',
      memberCount: 0,
      members: [],
      closedAt,
      deleteAfter: deadline,
    });
    const otherRoom = await rooms.create({
      title: '기존 종료 방',
      categoryId: new Types.ObjectId(),
      hostId: host,
      inviteCode: 'EXP002',
      memberCount: 0,
      members: [],
      closedAt,
    });
    const chat = await chats.create({ type: 'study_room', studyRoomId: room._id, members: [] });
    const otherChat = await chats.create({
      type: 'study_room',
      studyRoomId: otherRoom._id,
      members: [],
    });
    await messages.create({ chatRoomId: chat._id, senderId: host, text: '삭제 대상' });
    await messages.create({ chatRoomId: otherChat._id, senderId: host, text: '보존 대상' });

    await cleanup.cleanup(new Date(deadline.getTime() - 1));
    expect(await rooms.exists({ _id: room._id })).toBeTruthy();
    expect(await messages.countDocuments({ chatRoomId: chat._id })).toBe(1);
    await cleanup.cleanup(deadline);
    await cleanup.cleanup(deadline);
    expect(await rooms.exists({ _id: room._id })).toBeNull();
    expect(await chats.exists({ _id: chat._id })).toBeNull();
    expect(await messages.countDocuments({ chatRoomId: chat._id })).toBe(0);
    expect(await rooms.exists({ _id: otherRoom._id })).toBeTruthy();
    expect(await chats.exists({ _id: otherChat._id })).toBeTruthy();
    expect(await messages.countDocuments({ chatRoomId: otherChat._id })).toBe(1);
  });

  it('정리 중 장애가 나면 방을 남겨두고 다음 실행에서 이어서 처리한다', async () => {
    const host = new Types.ObjectId();
    const now = new Date();
    const room = await rooms.create({
      title: '재시도 방',
      categoryId: new Types.ObjectId(),
      hostId: host,
      inviteCode: 'EXP003',
      memberCount: 0,
      members: [],
      closedAt: now,
      deleteAfter: now,
    });
    const chat = await chats.create({ type: 'study_room', studyRoomId: room._id, members: [] });
    await messages.create({ chatRoomId: chat._id, senderId: host, text: '메시지' });
    const failing = vi
      .spyOn(chats, 'deleteMany')
      .mockRejectedValueOnce(new Error('DB unavailable'));
    try {
      await expect(cleanup.cleanup(now)).rejects.toThrow('DB unavailable');
      expect(await rooms.exists({ _id: room._id })).toBeTruthy();
      await cleanup.cleanup(now);
      expect(await rooms.exists({ _id: room._id })).toBeNull();
      expect(await chats.exists({ _id: chat._id })).toBeNull();
    } finally {
      failing.mockRestore();
    }
  });
});
