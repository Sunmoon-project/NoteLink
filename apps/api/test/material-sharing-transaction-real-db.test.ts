import mongoose, { type ClientSession, type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaterialSharingService } from '../src/modules/content/materials/material-sharing.service.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { Flashcard, FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { Message, MessageSchema } from '../src/modules/social/schemas/message.schema.js';
import { RoomSharedItem, RoomSharedItemSchema } from '../src/modules/studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const local = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_share_tx_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('공유 트랜잭션 실제 DB 검증', () => {
  let conn: Connection;
  let shared: Model<RoomSharedItem>;
  let messages: Model<Message>;
  let rooms: Model<StudyRoom>;
  let quizzes: Model<QuizSet>;
  let service: MaterialSharingService;
  const userId = new Types.ObjectId();
  const chatId = new Types.ObjectId();
  let roomId: Types.ObjectId;
  let quizId: Types.ObjectId;
  const notify = vi.fn();
  const send = vi.fn();
  const chat = {
    sendSharedItem: send,
    findSharedMessage: async (_room: string, _user: string, id: string) => {
      const message = await messages.findOne({ sharedItemId: new Types.ObjectId(id) }).lean().orFail();
      return { _id: String(message._id), chatRoomId: String(message.chatRoomId) };
    },
  };

  beforeAll(async () => {
    if (!local) throw new Error('MONGODB_VERIFY_URI는 localhost만 허용합니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    const hello = await conn.db!.admin().command({ hello: 1 });
    if (!hello.setName) throw new Error('트랜잭션 검증에는 replica set이 필요합니다');
    const materials = conn.model(Material.name, MaterialSchema);
    const users = conn.model(User.name, UserSchema);
    const cards = conn.model(Flashcard.name, FlashcardSchema);
    shared = conn.model(RoomSharedItem.name, RoomSharedItemSchema) as Model<RoomSharedItem>;
    messages = conn.model(Message.name, MessageSchema) as Model<Message>;
    rooms = conn.model(StudyRoom.name, StudyRoomSchema) as Model<StudyRoom>;
    quizzes = conn.model(QuizSet.name, QuizSetSchema) as Model<QuizSet>;
    await Promise.all([shared.syncIndexes(), messages.syncIndexes()]);
    service = new MaterialSharingService(materials as never, rooms, shared, users as never, chat as never, { notifyStudyMessage: notify } as never, quizzes, cards as never, conn);
  });

  afterAll(async () => {
    if (conn) { await conn.dropDatabase(); await conn.close(); }
  });

  beforeEach(async () => {
    await Promise.all([shared.deleteMany({}), messages.deleteMany({}), rooms.deleteMany({}), quizzes.deleteMany({})]);
    notify.mockReset();
    send.mockReset();
    const room = await rooms.create({ title: '테스트 방', categoryId: new Types.ObjectId(), hostId: userId, inviteCode: 'TX1234', members: [{ userId, role: 'host', status: 'joined' }] });
    roomId = room._id;
    const quiz = await quizzes.create({ ownerId: userId, source: 'manual', title: '테스트 퀴즈', status: 'ready' });
    quizId = quiz._id;
    send.mockImplementation(async (_room: string, _user: string, id: string, title: string, session: ClientSession) => {
      const [msg] = await messages.create([{ chatRoomId: chatId, senderId: userId, type: 'shared_item', text: title, sharedItemId: new Types.ObjectId(id) }], { session });
      return { _id: String(msg!._id), chatRoomId: String(chatId) };
    });
  });

  it('메시지 저장이 실패하면 공유 항목도 롤백된다', async () => {
    send.mockRejectedValueOnce(new Error('message write failed'));
    await expect(service.shareStudyItem(String(userId), String(roomId), 'quiz', String(quizId), 'request-1')).rejects.toThrow('message write failed');
    expect(await shared.countDocuments()).toBe(0);
    expect(await messages.countDocuments()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('동일 요청을 반복하고 동시에 보내도 항목과 메시지는 각각 하나다', async () => {
    const share = () => service.shareStudyItem(String(userId), String(roomId), 'quiz', String(quizId), 'same-request');
    await Promise.all([share(), share()]);
    await share();
    expect(await shared.countDocuments()).toBe(1);
    expect(await messages.countDocuments()).toBe(1);
  });
});
