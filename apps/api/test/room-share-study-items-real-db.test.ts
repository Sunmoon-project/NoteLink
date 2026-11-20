// 진짜 MongoDB에서 퀴즈 · 플래시카드를 스터디룸에 공유하고(채팅 자료 카드 포함), 방 멤버가 공유 자료 목록에서 보고 여는 흐름(#481).
// 확인하는 것: 내 것 · 준비된 퀴즈만 공유, 같은 퀴즈는 방에 한 번만(부분 unique 인덱스), 카드는 고른 묶음마다 새로,
// 채팅 카드의 종류(sharedKind), 공유 자료 목록 · 열기의 권한(현재 멤버 · 원본 · 공유자 탈퇴).
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 전용 DB를 만들고 끝나면 지운다. 소켓 서버 · 토큰은 가짜다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27047/?directConnection=true" npx vitest run test/room-share-study-items-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import {
  MaterialSharingService,
  SHARED_ITEMS_MAX,
} from '../src/modules/content/materials/material-sharing.service.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { Flashcard, FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { ChatRoom, ChatRoomSchema } from '../src/modules/social/schemas/chat-room.schema.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { Message, MessageSchema } from '../src/modules/social/schemas/message.schema.js';
import {
  RoomSharedItem,
  RoomSharedItemSchema,
} from '../src/modules/studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_room_study_items_${process.pid}_${Date.now()}`;

type FakeSocket = {
  handshake: { auth: { token: string } };
  emit: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
};

describe.skipIf(!isLocal)('진짜 DB 퀴즈 · 플래시카드 방 공유', () => {
  let conn: Connection;
  let users: Model<User>;
  let rooms: Model<StudyRoom>;
  let chats: Model<ChatRoom>;
  let messages: Model<Message>;
  let materials: Model<Material>;
  let items: Model<RoomSharedItem>;
  let sets: Model<QuizSet>;
  let cards: Model<Flashcard>;
  let chat: StudyChatService;
  let sharing: MaterialSharingService;
  let sockets: FakeSocket[];
  const notify = vi.fn(async (_n: { body: string }) => {});

  const owner = new Types.ObjectId();
  const member = new Types.ObjectId();
  const outsider = new Types.ObjectId();
  const roomId = new Types.ObjectId();
  const folderId = new Types.ObjectId();
  const quiz = new Types.ObjectId();
  const otherQuiz = new Types.ObjectId();
  const c1 = new Types.ObjectId();
  const c2 = new Types.ObjectId();
  const c3 = new Types.ObjectId();
  const theirCard = new Types.ObjectId();
  const R = roomId.toHexString();
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
    sets = conn.model(QuizSet.name, QuizSetSchema) as unknown as Model<QuizSet>;
    cards = conn.model(Flashcard.name, FlashcardSchema) as unknown as Model<Flashcard>;
    const friendships = conn.model(Friendship.name, FriendshipSchema);
    await Promise.all([chats.syncIndexes(), messages.syncIndexes(), items.syncIndexes()]);
    chat = new StudyChatService(
      rooms as never,
      chats as never,
      messages as never,
      users as never,
      friendships as never,
    );
    const tokens = { verifyAccess: async (t: string) => ({ userId: t }) };
    const gateway = new StudyChatGateway(tokens as never, chat, { chatMessage: vi.fn() } as never);
    (gateway as unknown as { server: unknown }).server = {
      in: () => ({ fetchSockets: async () => sockets }),
    };
    sharing = new MaterialSharingService(
      materials as never,
      rooms as never,
      items as never,
      users as never,
      sets as never,
      cards as never,
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
      [users, rooms, chats, messages, materials, items, sets, cards].map((m) =>
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
    const question = {
      _id: new Types.ObjectId(),
      order: 1,
      prompt: '교착 상태 조건이 아닌 것은?',
      choices: ['상호 배제', '선점'],
      answer: '선점',
      explanation: '비선점이 조건이다',
    };
    await sets.collection.insertMany([
      {
        _id: quiz,
        ownerId: owner,
        folderId,
        source: 'ai_generated',
        title: '교착 상태 퀴즈',
        status: 'ready',
        questions: [question],
        questionCount: 1,
        deletedAt: null,
        createdAt: new Date(),
      },
      {
        _id: otherQuiz,
        ownerId: owner,
        folderId,
        source: 'ai_generated',
        title: '만드는 중',
        status: 'generating',
        questions: [],
        deletedAt: null,
        createdAt: new Date(),
      },
    ]);
    await cards.collection.insertMany([
      {
        _id: c1,
        ownerId: owner,
        folderId,
        front: '뮤텍스',
        back: '한 번에 하나',
        deletedAt: null,
        createdAt: new Date(),
      },
      {
        _id: c2,
        ownerId: owner,
        folderId,
        front: '세마포어',
        back: '카운터',
        deletedAt: null,
        createdAt: new Date(),
      },
      {
        _id: c3,
        ownerId: owner,
        folderId,
        front: '스핀락',
        back: '바쁜 대기',
        deletedAt: null,
        createdAt: new Date(),
      },
      {
        _id: theirCard,
        ownerId: member,
        folderId,
        front: '남의 카드',
        back: '-',
        deletedAt: null,
        createdAt: new Date(),
      },
    ]);
    sockets = [socketOf(owner), socketOf(member), socketOf(outsider)];
  });

  const shareQuiz = (setId = quiz, by = owner) =>
    sharing.shareStudyItem(by.toHexString(), R, { kind: 'quiz', quizSetId: setId.toHexString() });
  const shareCards = (ids: Types.ObjectId[], by = owner) =>
    sharing.shareStudyItem(by.toHexString(), R, {
      kind: 'flashcards',
      flashcardIds: ids.map(String),
    });
  const chatCards = () =>
    messages.find({ type: 'shared_item' }).sort({ createdAt: 1, _id: 1 }).lean();

  it('퀴즈를 공유하면 공유 항목 · 「퀴즈」 채팅 카드가 생기고, 같은 퀴즈를 다시 보내도(동시에 보내도) 하나만 남는다', async () => {
    await Promise.all([shareQuiz(), shareQuiz()]);
    await shareQuiz();
    const saved = await items.find({ itemType: 'quiz' }).lean();
    expect(saved).toHaveLength(1);
    expect(String(saved[0]!.quizSetId)).toBe(quiz.toHexString());
    const list = await chatCards();
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe('교착 상태 퀴즈');
    expect(sockets[1]!.emit).toHaveBeenCalledWith(
      'chat:message',
      expect.objectContaining({
        type: 'shared_item',
        sharedKind: 'quiz',
        sharedItemId: String(saved[0]!._id),
      }),
    );
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]![0].body).toContain('퀴즈 「교착 상태 퀴즈」');
  });

  it('내 것이 아니거나 아직 만드는 중 · 지운 퀴즈, 방 멤버가 아니면 404이고 아무것도 남지 않는다', async () => {
    await expect(shareQuiz(otherQuiz)).rejects.toMatchObject({ status: 404 });
    await expect(shareQuiz(quiz, member)).rejects.toMatchObject({ status: 404 });
    await expect(shareQuiz(quiz, outsider)).rejects.toMatchObject({ status: 404 });
    await sets.updateOne({ _id: quiz }, { deletedAt: new Date() });
    await expect(shareQuiz()).rejects.toMatchObject({ status: 404 });
    expect(await items.countDocuments()).toBe(0);
    expect(await chatCards()).toHaveLength(0);
  });

  it('고른 카드들은 한 묶음으로 공유되고(채팅 카드 「플래시카드 N장」), 다른 조합은 새 묶음이다', async () => {
    await shareCards([c1, c2]);
    await shareCards([c2, c3]);
    const saved = await items
      .find({ itemType: 'flashcards' })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    expect(saved.map((s) => s.flashcardIds.map(String))).toEqual([
      [String(c1), String(c2)],
      [String(c2), String(c3)],
    ]);
    const list = await chatCards();
    expect(list.map((m) => m.text)).toEqual(['플래시카드 2장', '플래시카드 2장']);
    expect(sockets[1]!.emit).toHaveBeenCalledWith(
      'chat:message',
      expect.objectContaining({ sharedKind: 'flashcards' }),
    );
  });

  it('남의 카드가 하나라도 섞이면 404이고 아무것도 남지 않는다', async () => {
    await expect(shareCards([c1, theirCard])).rejects.toMatchObject({ status: 404 });
    expect(await items.countDocuments()).toBe(0);
  });

  it('공유 자료 목록에 퀴즈 · 카드 묶음도 나오고(원본을 지우면 빠짐), 노트 카드는 sharedKind 없이 그대로다', async () => {
    await shareQuiz();
    await shareCards([c1, c2]);
    const { items: listed } = await sharing.listRoomItems(member.toHexString(), R);
    expect(listed.map((i) => [i.itemType, i.title, i.sharedByNickname])).toEqual([
      ['flashcards', '플래시카드 2장', '주인'],
      ['quiz', '교착 상태 퀴즈', '주인'],
    ]);
    expect(listed[1]!.quizSetId).toBe(quiz.toHexString());
    await sets.updateOne({ _id: quiz }, { deletedAt: new Date() });
    await cards.updateOne({ _id: c1 }, { deletedAt: new Date() });
    const after = await sharing.listRoomItems(member.toHexString(), R);
    expect(after.items.map((i) => [i.itemType, i.title])).toEqual([
      ['flashcards', '플래시카드 1장'],
    ]);
  });

  it('방 멤버는 공유된 퀴즈(문제 · 정답) · 카드를 열고, 멤버가 아니거나 원본 · 공유자가 없어지면 404', async () => {
    await shareQuiz();
    await shareCards([c2, c1]);
    const [cardItem, quizItem] = (await sharing.listRoomItems(member.toHexString(), R)).items;
    const opened = await sharing.openRoomItem(member.toHexString(), R, quizItem!._id);
    expect(opened.quiz).toMatchObject({
      title: '교착 상태 퀴즈',
      questions: [expect.objectContaining({ answer: '선점', choices: ['상호 배제', '선점'] })],
    });
    const deck = await sharing.openRoomItem(member.toHexString(), R, cardItem!._id);
    // 고른 순서대로
    expect(deck.flashcards.map((c) => c.front)).toEqual(['세마포어', '뮤텍스']);
    expect(deck.quiz).toBeNull();
    await expect(
      sharing.openRoomItem(outsider.toHexString(), R, quizItem!._id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sharing.openRoomItem(member.toHexString(), R, new Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(sharing.openRoomItem(member.toHexString(), R, 'bad-id')).rejects.toMatchObject({
      status: 404,
    });
    await users.updateOne({ _id: owner }, { withdrawingAt: new Date() });
    await expect(
      sharing.openRoomItem(member.toHexString(), R, quizItem!._id),
    ).rejects.toMatchObject({ status: 404 });
    await users.updateOne({ _id: owner }, { withdrawingAt: null });
    await cards.updateMany({ _id: { $in: [c1, c2] } }, { deletedAt: new Date() });
    await expect(
      sharing.openRoomItem(member.toHexString(), R, cardItem!._id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('공유 자료가 목록 한도(100개)보다 많이 쌓여도 가장 오래된 퀴즈를 열 수 있다', async () => {
    const t0 = Date.now() - 10_000_000;
    const oldQuiz = new Types.ObjectId();
    const base = { roomId, sharedBy: owner, questionIds: [], deletedAt: null, folderId };
    await items.collection.insertMany([
      {
        _id: oldQuiz,
        ...base,
        itemType: 'quiz',
        quizSetId: quiz,
        flashcardIds: [],
        createdAt: new Date(t0),
      },
      ...Array.from({ length: SHARED_ITEMS_MAX + 1 }, (_, i) => ({
        _id: new Types.ObjectId(),
        ...base,
        itemType: 'flashcards',
        flashcardIds: [c1],
        createdAt: new Date(t0 + 1000 * (i + 1)),
      })),
    ]);
    const listed = (await sharing.listRoomItems(member.toHexString(), R)).items;
    expect(listed).toHaveLength(SHARED_ITEMS_MAX);
    expect(listed.some((i) => i._id === oldQuiz.toHexString())).toBe(false);
    const opened = await sharing.openRoomItem(member.toHexString(), R, oldQuiz.toHexString());
    expect(opened.quiz?.title).toBe('교착 상태 퀴즈');
    // 한도 밖이어도 권한 판단은 그대로
    await expect(
      sharing.openRoomItem(outsider.toHexString(), R, oldQuiz.toHexString()),
    ).rejects.toMatchObject({ status: 404 });
    await users.updateOne({ _id: owner }, { withdrawingAt: new Date() });
    await expect(
      sharing.openRoomItem(member.toHexString(), R, oldQuiz.toHexString()),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('방 채팅 기록에서도 카드 종류(sharedKind)가 보인다', async () => {
    await shareQuiz();
    const chatRoom = await chats.findOne({ studyRoomId: roomId }).lean();
    const history = await chat.history(String(chatRoom!._id), member.toHexString());
    expect(history).toEqual([expect.objectContaining({ type: 'shared_item', sharedKind: 'quiz' })]);
  });
});
