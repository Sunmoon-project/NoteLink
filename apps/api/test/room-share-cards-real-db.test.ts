// 진짜 MongoDB에서 노트를 방에 공유하면 방 채팅에 자료 카드(shared_item)가 올라가는지 확인한다(실기기 피드백 2026-11-20).
// 확인하는 것: 노트마다 카드 하나(글 = 노트 제목, sharedItemId = 공유 항목), 그 채팅을 보는 현재 멤버에게만 바로 보냄,
// 같은 공유를 다시 보내도 카드가 늘지 않음, 카드 없이 공유돼 있던 노트는 카드를 채움, 카드 푸시는 따로 보내지 않음(공유 알림이 감),
// 카드가 실패해도 공유는 성공.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 전용 DB를 만들고 끝나면 지운다. 소켓 서버 · 토큰은 가짜다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27047/?directConnection=true" npx vitest run test/room-share-cards-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { MaterialSharingService } from '../src/modules/content/materials/material-sharing.service.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { ChatRoom, ChatRoomSchema } from '../src/modules/social/schemas/chat-room.schema.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { Message, MessageSchema } from '../src/modules/social/schemas/message.schema.js';
import {
  RoomSharedItem,
  RoomSharedItemSchema,
} from '../src/modules/studyroom/schemas/room-shared-item.schema.js';
import { Flashcard, FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_room_cards_${process.pid}_${Date.now()}`;

type FakeSocket = {
  handshake: { auth: { token: string } };
  emit: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
};

describe.skipIf(!isLocal)('진짜 DB 방 공유 → 채팅 자료 카드', () => {
  let conn: Connection;
  let users: Model<User>;
  let rooms: Model<StudyRoom>;
  let chats: Model<ChatRoom>;
  let messages: Model<Message>;
  let materials: Model<Material>;
  let items: Model<RoomSharedItem>;
  let gateway: StudyChatGateway;
  let sharing: MaterialSharingService;
  let sockets: FakeSocket[];
  const notices = { chatMessage: vi.fn() };
  const notify = vi.fn(async (_n: { body: string }) => {});

  const owner = new Types.ObjectId();
  const member = new Types.ObjectId();
  const outsider = new Types.ObjectId();
  const roomId = new Types.ObjectId();
  const folderId = new Types.ObjectId();
  const n1 = new Types.ObjectId();
  const n2 = new Types.ObjectId();
  const socketOf = (userId: Types.ObjectId): FakeSocket => ({
    handshake: { auth: { token: userId.toHexString() } },
    emit: vi.fn(),
    leave: vi.fn(async () => {}),
  });

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    users = conn.model(User.name, UserSchema) as unknown as Model<User>;
    rooms = conn.model(StudyRoom.name, StudyRoomSchema) as unknown as Model<StudyRoom>;
    chats = conn.model(ChatRoom.name, ChatRoomSchema) as unknown as Model<ChatRoom>;
    messages = conn.model(Message.name, MessageSchema) as unknown as Model<Message>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    items = conn.model(
      RoomSharedItem.name,
      RoomSharedItemSchema,
    ) as unknown as Model<RoomSharedItem>;
    const friendships = conn.model(Friendship.name, FriendshipSchema);
    await Promise.all([chats.syncIndexes(), messages.syncIndexes(), items.syncIndexes()]);
    const chat = new StudyChatService(
      rooms as never,
      chats as never,
      messages as never,
      users as never,
      friendships as never,
    );
    const tokens = { verifyAccess: async (t: string) => ({ userId: t }) };
    gateway = new StudyChatGateway(tokens as never, chat, notices as never);
    // 방 채팅 채널에 들어와 있는 연결들(가짜 socket.io 서버)
    (gateway as unknown as { server: unknown }).server = {
      in: () => ({ fetchSockets: async () => sockets }),
    };
    sharing = new MaterialSharingService(
      materials as never,
      rooms as never,
      items as never,
      users as never,
      conn.model(QuizSet.name, QuizSetSchema) as never,
      conn.model(Flashcard.name, FlashcardSchema) as never,
      { notify } as never,
      gateway,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      [users, rooms, chats, messages, materials, items].map((m) =>
        (m as Model<unknown>).deleteMany({}),
      ),
    );
    await users.collection.insertMany([
      { _id: owner, nickname: '주인', deletedAt: null, withdrawingAt: null },
      { _id: member, nickname: '멤버', deletedAt: null, withdrawingAt: null },
      { _id: outsider, nickname: '남', deletedAt: null, withdrawingAt: null },
    ]);
    await rooms.collection.insertOne({
      _id: roomId,
      title: '운영체제 스터디',
      hostId: owner,
      closedAt: null,
      memberCount: 2,
      members: [
        { userId: owner, role: 'host', status: 'joined' },
        { userId: member, role: 'member', status: 'joined' },
      ],
    });
    await materials.collection.insertMany([
      { _id: n1, ownerId: owner, folderId, title: '프로세스 필기', deletedAt: null },
      { _id: n2, ownerId: owner, folderId, title: '스케줄링 요약', deletedAt: null },
    ]);
    sockets = [socketOf(owner), socketOf(member), socketOf(outsider)];
  });

  const share = (ids: Types.ObjectId[]) =>
    sharing.share(owner.toHexString(), {
      materialIds: ids.map((id) => id.toHexString()),
      target: { type: 'room', id: roomId.toHexString() },
    });
  const cards = () => messages.find({ type: 'shared_item' }).sort({ createdAt: 1, _id: 1 }).lean();

  it('노트마다 방 채팅에 자료 카드(제목 · 공유 항목)를 남기고, 보고 있는 현재 멤버에게만 바로 보낸다', async () => {
    await share([n1, n2]);
    const shared = await items.find({}).lean();
    const list = await cards();
    expect(list.map((m) => m.text).sort()).toEqual(['스케줄링 요약', '프로세스 필기']);
    expect(list.map((m) => String(m.sharedItemId)).sort()).toEqual(
      shared.map((i) => String(i._id)).sort(),
    );
    expect(list.every((m) => m.senderId.equals(owner))).toBe(true);
    const chat = await chats.findOne({ type: 'study_room', studyRoomId: roomId }).lean();
    expect(list.every((m) => m.chatRoomId.equals(chat!._id))).toBe(true);
    // 주인 · 멤버의 연결은 받고, 멤버가 아닌 연결은 받지 않고 채널에서 빠진다
    const [mine, theirs, stranger] = sockets;
    expect(mine!.emit).toHaveBeenCalledTimes(2);
    expect(theirs!.emit).toHaveBeenCalledTimes(2);
    expect(theirs!.emit).toHaveBeenCalledWith(
      'chat:message',
      expect.objectContaining({ type: 'shared_item', senderNickname: '주인' }),
    );
    expect(stranger!.emit).not.toHaveBeenCalled();
    expect(stranger!.leave).toHaveBeenCalled();
    // 카드 푸시는 따로 보내지 않는다(공유 알림 하나만)
    expect(notices.chatMessage).not.toHaveBeenCalled();
  });

  it('같은 공유를 다시 보내도 카드는 늘지 않고 다시 보내지 않는다', async () => {
    await share([n1]);
    sockets.forEach((s) => s.emit.mockClear());
    await share([n1]);
    expect(await cards()).toHaveLength(1);
    expect(sockets[1]!.emit).not.toHaveBeenCalled();
  });

  it('카드 없이 이미 공유돼 있던 노트는 다시 공유하면 카드를 채운다', async () => {
    await items.collection.insertOne({
      roomId,
      itemType: 'material',
      materialId: n1,
      sharedBy: owner,
      folderId,
      questionIds: [],
      flashcardIds: [],
      deletedAt: null,
      createdAt: new Date(),
    });
    await share([n1, n2]);
    expect((await cards()).map((m) => m.text).sort()).toEqual(['스케줄링 요약', '프로세스 필기']);
    // 새로 공유된 노트는 하나라 공유 알림은 「노트 1개」
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]![0]).toMatchObject({ body: expect.stringContaining('노트 1개') });
  });

  it('카드를 올리다 실패해도 공유는 성공한다', async () => {
    const spy = vi.spyOn(gateway, 'postSharedNotes').mockRejectedValueOnce(new Error('down'));
    await expect(share([n1])).resolves.toBeUndefined();
    expect(await items.countDocuments({ materialId: n1 })).toBe(1);
    spy.mockRestore();
  });
});
