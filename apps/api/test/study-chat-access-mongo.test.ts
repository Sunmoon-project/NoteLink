import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatRoom, ChatRoomSchema } from '../src/modules/social/schemas/chat-room.schema.js';
import { Message, MessageSchema } from '../src/modules/social/schemas/message.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);
describe.skipIf(!local)('실제 MongoDB 채팅방 생성', () => {
  const suffix = randomBytes(8).toString('hex');
  const roomsName = `test_chat_rooms_${suffix}`;
  const chatsName = `test_chats_${suffix}`;
  const messagesName = `test_messages_${suffix}`;
  const userId = new Types.ObjectId();
  const roomId = new Types.ObjectId();
  let connection: mongoose.Connection;
  let rooms: mongoose.Model<StudyRoom>;
  let chats: mongoose.Model<ChatRoom>;
  let messages: mongoose.Model<Message>;
  let service: StudyChatService;
  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri!, { serverSelectionTimeoutMS: 5000 })
      .asPromise();
    rooms = connection.model(StudyRoom.name, StudyRoomSchema, roomsName);
    chats = connection.model(ChatRoom.name, ChatRoomSchema, chatsName);
    messages = connection.model(Message.name, MessageSchema, messagesName);
    await chats.init();
    await messages.init();
    await rooms.create({
      _id: roomId,
      title: '테스트',
      categoryId: new Types.ObjectId(),
      hostId: userId,
      inviteCode: 'TEST77',
      members: [{ userId, role: 'host', status: 'joined' }],
    });
    const users = {
      findById: () => ({ lean: async () => ({ nickname: '참여자' }) }),
      find: () => ({ lean: async () => [{ _id: userId, nickname: '참여자' }] }),
    };
    service = new StudyChatService(rooms, chats, messages, users as never, {} as never);
  });
  afterAll(async () => {
    if (connection) {
      await connection.dropCollection(roomsName).catch(() => {});
      await connection.dropCollection(chatsName).catch(() => {});
      await connection.dropCollection(messagesName).catch(() => {});
      await connection.close();
    }
  });
  it('동일 clientId의 동시 재전송은 메시지 하나만 저장하고 기록에서 조회한다', async () => {
    const chat = await service.getChat(String(roomId), String(userId));
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.send(String(chat._id), String(userId), '안녕하세요', 'same123'),
      ),
    );
    expect(new Set(results.map((m) => m._id)).size).toBe(1);
    expect(await messages.countDocuments({ chatRoomId: chat._id })).toBe(1);
    expect(await service.history(String(chat._id), String(userId))).toMatchObject([
      { text: '안녕하세요', clientId: 'same123' },
    ]);
    await expect(
      service.send(String(chat._id), String(userId), '다른 내용', 'same123'),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('동시 최초 조회에도 채팅방은 하나만 생긴다', async () => {
    const result = await Promise.all(
      Array.from({ length: 12 }, () => service.getChat(String(roomId), String(userId))),
    );
    expect(new Set(result.map((r) => String(r._id))).size).toBe(1);
    expect(await chats.countDocuments({ studyRoomId: roomId, type: 'study_room' })).toBe(1);
    await expect(
      service.getChat(String(roomId), String(new Types.ObjectId())),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('50개씩 이전 페이지를 읽어 100개가 넘는 대화도 빠짐없이 조회한다', async () => {
    const chat = await service.getChat(String(roomId), String(userId));
    for (let i = 0; i < 125; i++) {
      await messages.create({
        chatRoomId: chat._id,
        senderId: userId,
        type: 'text',
        text: `message ${i}`,
        clientId: `paging-${i}`,
      });
    }
    let before: string | undefined;
    const ids: string[] = [];
    for (;;) {
      const page = await service.history(String(chat._id), String(userId), before);
      ids.push(...page.map((item) => item._id));
      if (page.length < 50) break;
      before = page[0]!._id;
    }
    expect(ids).toHaveLength(126);
    expect(new Set(ids).size).toBe(126);
    await expect(
      service.history(String(chat._id), String(userId), 'invalid'),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('탈퇴·강퇴한 멤버와 종료된 방은 조회할 수 없다', async () => {
    for (const status of ['left', 'kicked']) {
      await rooms.updateOne({ _id: roomId }, { $set: { 'members.0.status': status } });
      await expect(service.getChat(String(roomId), String(userId))).rejects.toMatchObject({
        status: 404,
      });
    }
    await rooms.updateOne(
      { _id: roomId },
      { $set: { 'members.0.status': 'joined', closedAt: new Date() } },
    );
    await expect(service.getChat(String(roomId), String(userId))).rejects.toMatchObject({
      status: 404,
    });
  });
});
