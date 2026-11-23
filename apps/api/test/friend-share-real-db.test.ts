// 진짜 MongoDB에서 친구에게 노트 보내기(#554)를 확인한다.
// 확인하는 것: 친구 여러 명 × 노트 여러 개 저장(친구 관계 id), 1:1 채팅 공유 카드 · 마지막 메시지 · 알림 연결, 친구 아닌 사람 · 남의 노트가
// 섞이면 아무것도 안 남김, 다시 보내도 줄 · 카드가 늘지 않음, 받은 사람 읽기(ownerOfShared) · 철회 · 친구 끊기 · 다시 친구 되기,
// 카드 열기(끝난 공유는 active: false), 「내 노트로 복사」(노트 · 정리 결과 · 파일 사본, 정리 중이면 409).
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 전용 DB를 만들고 끝나면 지운다. 소켓 서버 · 토큰 · 저장소는 가짜다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27047/?directConnection=true" npx vitest run test/friend-share-real-db.test.ts
import { ValidationPipe } from '@nestjs/common';
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { ShareMaterialsDto } from '../src/modules/content/materials/dto/share-materials.dto.js';
import { FriendShareService } from '../src/modules/content/materials/friend-share.service.js';
import { MaterialSharingService } from '../src/modules/content/materials/material-sharing.service.js';
import { Folder, FolderSchema } from '../src/modules/content/schemas/folder.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { Flashcard, FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { FriendsService } from '../src/modules/social/friends/friends.service.js';
import { ChatRoom, ChatRoomSchema } from '../src/modules/social/schemas/chat-room.schema.js';
import {
  FriendSharedItem,
  FriendSharedItemSchema,
} from '../src/modules/social/schemas/friend-shared-item.schema.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { Message, MessageSchema } from '../src/modules/social/schemas/message.schema.js';
import {
  RoomSharedItem,
  RoomSharedItemSchema,
} from '../src/modules/studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';
import { StudyRoomNoticesService } from '../src/modules/studyroom/study-room-notices.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_friend_share_${process.pid}_${Date.now()}`;
const BLOB = 'https://acct.blob.core.windows.net/notes';

describe.skipIf(!isLocal)('진짜 DB 친구에게 노트 보내기', () => {
  let conn: Connection;
  let users: Model<User>;
  let friendships: Model<Friendship>;
  let materials: Model<Material>;
  let folders: Model<Folder>;
  let jobs: Model<AiJob>;
  let shares: Model<FriendSharedItem>;
  let messages: Model<Message>;
  let chats: Model<ChatRoom>;
  let friendShares: FriendShareService;
  let sharing: MaterialSharingService;
  let friends: FriendsService;
  const notify = vi.fn(async (_n: Record<string, unknown>) => {});
  const copies: string[] = [];
  // 노트 동기화(MaterialsService.sync) · 올리기 한도 대역
  const sync = vi.fn(async (row: unknown) => row);
  const reserve = vi.fn((): { ok: true } | { ok: false; retryAfterMs: number } => ({ ok: true }));
  const blobs = {
    copyUpload: vi.fn(async (url: string, _from: string, prefix: string) => {
      const out = `${BLOB}/${prefix}${new Types.ObjectId().toHexString()}${url.slice(url.lastIndexOf('.'))}`;
      copies.push(out);
      return out;
    }),
    deleteCopy: vi.fn(async () => {}),
  };

  const owner = new Types.ObjectId();
  const f1 = new Types.ObjectId();
  const f2 = new Types.ObjectId();
  const stranger = new Types.ObjectId();
  const n1 = new Types.ObjectId();
  const n2 = new Types.ObjectId();
  const ownerFolder = new Types.ObjectId();
  const f1Folder = new Types.ObjectId();
  const jobId = new Types.ObjectId();
  const hex = (id: Types.ObjectId) => id.toHexString();
  const pair = (a: Types.ObjectId, b: Types.ObjectId) =>
    hex(a) < hex(b) ? { userA: a, userB: b } : { userA: b, userB: a };
  const befriend = (a: Types.ObjectId, b: Types.ObjectId) =>
    friendships.create({ ...pair(a, b), requesterId: a, status: 'accepted' });

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    users = conn.model(User.name, UserSchema) as unknown as Model<User>;
    friendships = conn.model(Friendship.name, FriendshipSchema) as unknown as Model<Friendship>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    folders = conn.model(Folder.name, FolderSchema) as unknown as Model<Folder>;
    jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    shares = conn.model(
      FriendSharedItem.name,
      FriendSharedItemSchema,
    ) as unknown as Model<FriendSharedItem>;
    messages = conn.model(Message.name, MessageSchema) as unknown as Model<Message>;
    chats = conn.model(ChatRoom.name, ChatRoomSchema) as unknown as Model<ChatRoom>;
    const rooms = conn.model(StudyRoom.name, StudyRoomSchema);
    await Promise.all([
      shares.syncIndexes(),
      messages.syncIndexes(),
      chats.syncIndexes(),
      friendships.syncIndexes(),
    ]);
    const chat = new StudyChatService(
      rooms as never,
      chats as never,
      messages as never,
      users as never,
      friendships as never,
    );
    const notices = new StudyRoomNoticesService(
      chats as never,
      rooms as never,
      { notify } as never,
    );
    const gateway = new StudyChatGateway(
      { verifyAccess: async (t: string) => ({ userId: t }) } as never,
      chat,
      notices,
    );
    // 아무도 채팅을 보고 있지 않다(푸시 · 알림으로 간다)
    (gateway as unknown as { server: unknown }).server = {
      in: () => ({ fetchSockets: async () => [] }),
    };
    friendShares = new FriendShareService(
      materials as never,
      folders as never,
      jobs as never,
      users as never,
      friendships as never,
      shares as never,
      { sync: (_owner: string, row: unknown) => sync(row) } as never,
      { reserve: async () => reserve() } as never,
      blobs as never,
      gateway,
    );
    sharing = new MaterialSharingService(
      materials as never,
      rooms as never,
      conn.model(RoomSharedItem.name, RoomSharedItemSchema) as never,
      users as never,
      conn.model(QuizSet.name, QuizSetSchema) as never,
      conn.model(Flashcard.name, FlashcardSchema) as never,
      { notify } as never,
      undefined,
      friendShares,
    );
    friends = new FriendsService(
      friendships as never,
      users as never,
      conn.model('TimetableShare', new mongoose.Schema({}, { strict: false })) as never,
      { notify } as never,
      shares as never,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    sync.mockImplementation(async (row: unknown) => row);
    reserve.mockImplementation(() => ({ ok: true }));
    copies.length = 0;
    await Promise.all(
      [users, friendships, materials, folders, jobs, shares, messages, chats].map((m) =>
        (m as Model<unknown>).deleteMany({}),
      ),
    );
    const people: [Types.ObjectId, string][] = [
      [owner, '주인'],
      [f1, '하나'],
      [f2, '두리'],
      [stranger, '남'],
    ];
    await users.collection.insertMany(
      people.map(([_id, nickname]) => ({ _id, nickname, deletedAt: null, withdrawingAt: null })),
    );
    await befriend(owner, f1);
    await befriend(owner, f2);
    await folders.collection.insertMany([
      {
        _id: ownerFolder,
        ownerId: owner,
        name: '주인 폴더',
        deletedAt: null,
        updatedAt: new Date(),
      },
      { _id: f1Folder, ownerId: f1, name: '하나 폴더', deletedAt: null, updatedAt: new Date() },
    ]);
    const src = `${BLOB}/uploads/audio/${hex(owner)}/a.m4a`;
    await materials.collection.insertMany([
      {
        _id: n1,
        ownerId: owner,
        folderId: ownerFolder,
        kind: 'recording',
        source: 'live_recording',
        title: '운영체제 강의',
        processing: { status: 'done', progress: 100, jobId },
        summary: { sections: [{ heading: '요약', body: '본문' }], points: ['핵심'] },
        keywords: ['프로세스'],
        concepts: [],
        bookmarks: [{ atSec: 3, label: '중요' }],
        pages: [],
        blobUrls: [src],
        deletedAt: null,
      },
      {
        _id: n2,
        ownerId: owner,
        folderId: ownerFolder,
        kind: 'handwriting',
        source: 'camera',
        title: '필기',
        processing: { status: 'processing', progress: 40, jobId: null },
        pages: [],
        blobUrls: [],
        deletedAt: null,
      },
    ]);
    await jobs.collection.insertOne({
      _id: jobId,
      type: 'recording_summary',
      status: 'succeeded',
      userId: owner,
      targetType: 'material',
      targetId: n1,
      input: { audioUrl: `${src}?sas=secret`, sizeBytes: 1234 },
      result: { transcript: '안녕하세요' },
      progress: 100,
      attempts: 1,
    });
  });

  const send = (notes: Types.ObjectId[], to: Types.ObjectId[]) =>
    sharing.share(hex(owner), {
      materialIds: notes.map(hex),
      target: { type: 'friend', ids: to.map(hex) },
    });
  const shareOf = async (friend: Types.ObjectId, note = n1) =>
    (await shares.findOne({ friendId: friend, materialId: note }).lean())!;

  it('친구 여러 명 × 노트 여러 개를 저장하고, 친구마다 1:1 채팅에 노트별 공유 카드와 친구 알림을 남긴다', async () => {
    await send([n1, n2], [f1, f2]);
    const rows = await shares.find({}).lean();
    expect(rows).toHaveLength(4);
    const links = await friendships.find({}).lean();
    for (const r of rows) {
      expect(r.ownerId.equals(owner)).toBe(true);
      expect(r.revokedAt).toBeNull();
      const link = links.find((l) => l._id.equals(r.friendshipId))!;
      expect([hex(link.userA), hex(link.userB)]).toContain(hex(r.friendId));
    }
    const cards = await messages.find({ type: 'shared_item' }).lean();
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => String(c.sharedItemId)).sort()).toEqual(
      rows.map((r) => String(r._id)).sort(),
    );
    const direct = await chats.find({ type: 'direct' }).lean();
    expect(direct).toHaveLength(2);
    expect(direct.every((c) => (c.lastMessage as { type: string }).type === 'shared_item')).toBe(
      true,
    );
    await vi.waitFor(() =>
      expect(notify.mock.calls.filter(([n]) => n.type === 'friend-share')).toHaveLength(4),
    );
    expect(notify.mock.calls.find(([n]) => n.type === 'friend-share')![0]).toMatchObject({
      category: 'friend',
      body: expect.stringContaining('주인님이'),
    });
  });

  it('친구 아닌 사람이 섞이면 400 NOT_FRIEND, 남의 노트가 섞이면 404 — 아무것도 남기지 않는다', async () => {
    await expect(send([n1], [f1, stranger])).rejects.toMatchObject({
      response: { code: 'NOT_FRIEND' },
    });
    // 나 자신도 친구가 아니다
    await expect(send([n1], [f1, owner])).rejects.toMatchObject({
      response: { code: 'NOT_FRIEND' },
    });
    const theirs = new Types.ObjectId();
    await materials.collection.insertOne({ _id: theirs, ownerId: f1, title: 'x', deletedAt: null });
    await expect(send([n1, theirs], [f1])).rejects.toMatchObject({ status: 404 });
    expect(await shares.countDocuments()).toBe(0);
    expect(await messages.countDocuments()).toBe(0);
  });

  it('같은 공유를 다시 보내도 줄 · 카드가 늘지 않는다', async () => {
    await send([n1], [f1]);
    await send([n1], [f1]);
    expect(await shares.countDocuments()).toBe(1);
    expect(await messages.countDocuments({ type: 'shared_item' })).toBe(1);
  });

  it('친구는 50명까지(DTO), 친구 대상은 ids 가 있어야 한다', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
    const meta = { type: 'body' as const, metatype: ShareMaterialsDto };
    const many = Array.from({ length: 51 }, () => hex(new Types.ObjectId()));
    await expect(
      pipe.transform({ materialIds: [hex(n1)], target: { type: 'friend', ids: many } }, meta),
    ).rejects.toBeDefined();
    await expect(
      pipe.transform({ materialIds: [hex(n1)], target: { type: 'friend' } }, meta),
    ).rejects.toBeDefined();
    await expect(
      pipe.transform(
        { materialIds: [hex(n1)], target: { type: 'friend', ids: many.slice(0, 50) } },
        meta,
      ),
    ).resolves.toBeDefined();
    await expect(
      pipe.transform({ materialIds: [hex(n1)], target: { type: 'room', id: hex(n1) } }, meta),
    ).resolves.toBeDefined();
  });

  it('받은 친구는 주인으로 읽고, 다른 사람은 못 읽는다. 철회하면 못 읽고 카드는 끝난 공유가 된다', async () => {
    await send([n1], [f1]);
    expect(await sharing.ownerOfShared(hex(f1), hex(n1))).toBe(hex(owner));
    expect(await sharing.ownerOfShared(hex(f2), hex(n1))).toBeNull();
    expect(await sharing.ownerOfShared(hex(stranger), hex(n1))).toBeNull();
    const row = await shareOf(f1);
    expect(await friendShares.open(hex(f1), hex(row._id))).toMatchObject({
      active: true,
      mine: false,
      title: '운영체제 강의',
      kind: 'recording',
      ownerNickname: '주인',
    });
    await expect(friendShares.open(hex(f2), hex(row._id))).rejects.toMatchObject({ status: 404 });
    // 받은 사람은 철회할 수 없다
    await expect(friendShares.revoke(hex(f1), hex(row._id))).rejects.toMatchObject({
      status: 404,
    });
    await friendShares.revoke(hex(owner), hex(row._id));
    await friendShares.revoke(hex(owner), hex(row._id)); // 두 번째도 그대로
    expect(await sharing.ownerOfShared(hex(f1), hex(n1))).toBeNull();
    // 끝난 공유는 받은 사람에게 노트 제목 · 종류를 보여 주지 않는다(보낸 사람은 본다)
    expect(await friendShares.open(hex(f1), hex(row._id))).toMatchObject({
      active: false,
      title: '',
      kind: null,
    });
    expect(await friendShares.open(hex(owner), hex(row._id))).toMatchObject({
      mine: true,
      title: '운영체제 강의',
    });
    // 철회한 뒤 다시 보내면 새 공유 · 새 카드
    await send([n1], [f1]);
    expect(await shares.countDocuments({ revokedAt: null })).toBe(1);
    expect(await messages.countDocuments({ type: 'shared_item' })).toBe(2);
  });

  it('친구를 끊으면 공유가 지워지고, 다시 친구가 돼도 살아나지 않는다', async () => {
    await send([n1], [f1]);
    const row = await shareOf(f1);
    await friends.remove(hex(f1), hex(owner));
    expect(await shares.countDocuments()).toBe(0);
    expect(await sharing.ownerOfShared(hex(f1), hex(n1))).toBeNull();
    await expect(friendShares.open(hex(f1), hex(row._id))).rejects.toMatchObject({ status: 404 });
    await befriend(owner, f1);
    expect(await sharing.ownerOfShared(hex(f1), hex(n1))).toBeNull();
  });

  it('끊는 사이에 남은 옛 관계의 줄도 다시 친구가 된 뒤에는 열리지 않는다', async () => {
    await send([n1], [f1]);
    // 정리 전에 관계만 지워졌다(쓰기와 끊기가 겹침)
    await friendships.deleteOne(pair(owner, f1));
    await befriend(owner, f1);
    expect(await sharing.ownerOfShared(hex(f1), hex(n1))).toBeNull();
    expect(await friendShares.open(hex(f1), hex((await shareOf(f1))._id))).toMatchObject({
      active: false,
    });
  });

  it('보낸 사람이 탈퇴(유예 포함)하면 받은 사람이 못 읽는다', async () => {
    await send([n1], [f1]);
    await users.updateOne({ _id: owner }, { withdrawingAt: new Date() });
    expect(await sharing.ownerOfShared(hex(f1), hex(n1))).toBeNull();
    expect(await friendShares.open(hex(f1), hex((await shareOf(f1))._id))).toMatchObject({
      active: false,
    });
  });

  it('내 노트로 복사: 노트 · 정리 결과 · 녹음 파일 사본을 내 폴더에 만든다(보낸 사람 SAS 는 옮기지 않음)', async () => {
    await send([n1], [f1]);
    await materials.updateOne(
      { _id: n1 },
      { $set: { diagrams: [{ after: '첫 줄', diagram: { kind: 'flow', nodes: [], edges: [] } }] } },
      { strict: false },
    );
    const row = await shareOf(f1);
    const out = await friendShares.copy(hex(f1), hex(row._id));
    expect(out.folderId).toBe(hex(f1Folder));
    const copy = (await materials.findById(out._id).lean())!;
    expect(copy.ownerId.equals(f1)).toBe(true);
    expect(copy.title).toBe('운영체제 강의');
    expect(copy.kind).toBe('recording');
    expect(copy.summary?.points).toEqual(['핵심']);
    // 필기 도식도 사본에 남는다
    expect(copy.diagrams).toHaveLength(1);
    // 북마크는 보낸 사람의 메모라 옮기지 않는다
    expect(copy.bookmarks).toEqual([]);
    expect(copy.processing.status).toBe('done');
    // 원본은 보낸 사람의 올린 파일 폴더 안이어야 복사한다
    expect(blobs.copyUpload).toHaveBeenCalledWith(
      `${BLOB}/uploads/audio/${hex(owner)}/a.m4a`,
      `uploads/audio/${hex(owner)}/`,
      `uploads/audio/${hex(f1)}/`,
    );
    expect(copy.blobUrls).toEqual(copies);
    const job = (await jobs.findById(copy.processing.jobId).lean())!;
    expect(job.userId.equals(f1)).toBe(true);
    expect(job.targetId.equals(copy._id)).toBe(true);
    expect(job.result).toEqual({ transcript: '안녕하세요' });
    expect(job.input).toEqual({ sizeBytes: 1234 });
    // 원본은 그대로
    expect((await materials.findById(n1).lean())!.ownerId.equals(owner)).toBe(true);
  });

  it('복사: 정리 중이면 409, 보낸 사람 · 끝난 공유 · 남의 폴더는 404, 폴더가 없으면 400', async () => {
    await send([n1, n2], [f1]);
    const r1 = await shareOf(f1, n1);
    const r2 = await shareOf(f1, n2);
    await expect(friendShares.copy(hex(f1), hex(r2._id))).rejects.toMatchObject({ status: 409 });
    await expect(friendShares.copy(hex(owner), hex(r1._id))).rejects.toMatchObject({
      status: 404,
    });
    await expect(friendShares.copy(hex(f1), hex(r1._id), hex(ownerFolder))).rejects.toMatchObject({
      status: 404,
    });
    await folders.deleteMany({ ownerId: f1 });
    await expect(friendShares.copy(hex(f1), hex(r1._id))).rejects.toMatchObject({ status: 400 });
    await friendShares.revoke(hex(owner), hex(r1._id));
    await expect(friendShares.copy(hex(f1), hex(r1._id))).rejects.toMatchObject({ status: 404 });
    expect(await materials.countDocuments({ ownerId: f1 })).toBe(0);
  });

  it('복사 도중 파일 복사가 실패하면 노트를 만들지 않고 만든 사본을 지운다', async () => {
    await materials.updateOne(
      { _id: n1 },
      {
        blobUrls: [
          `${BLOB}/uploads/audio/${hex(owner)}/a.m4a`,
          `${BLOB}/uploads/audio/${hex(owner)}/b.m4a`,
        ],
      },
    );
    await send([n1], [f1]);
    blobs.copyUpload.mockImplementationOnce(async () => `${BLOB}/uploads/audio/x/first.m4a`);
    blobs.copyUpload.mockRejectedValueOnce(new Error('down'));
    await expect(friendShares.copy(hex(f1), hex((await shareOf(f1))._id))).rejects.toThrow('down');
    expect(blobs.deleteCopy).toHaveBeenCalledWith(`${BLOB}/uploads/audio/x/first.m4a`);
    expect(await materials.countDocuments({ ownerId: f1 })).toBe(0);
  });

  it('복사 마지막에 폴더 갱신이 실패하면 넣은 노트 · 작업 · 사본 파일을 모두 지운다', async () => {
    await send([n1], [f1]);
    const spy = vi.spyOn(folders, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    try {
      await expect(friendShares.copy(hex(f1), hex((await shareOf(f1))._id))).rejects.toThrow(
        'db down',
      );
    } finally {
      spy.mockRestore();
    }
    expect(copies.length).toBeGreaterThan(0);
    expect(blobs.deleteCopy).toHaveBeenCalledTimes(copies.length);
    expect(await materials.countDocuments({ ownerId: f1 })).toBe(0);
    expect(await jobs.countDocuments({ userId: f1 })).toBe(0);
  });

  it('복사: 주인이 아직 안 열어 정리 결과가 반영 안 된 노트도 먼저 반영(sync)해서 복사한다', async () => {
    await send([n2], [f1]);
    sync.mockImplementationOnce(async (row: unknown) => ({
      ...(row as object),
      processing: { status: 'done', progress: 100, jobId: null },
    }));
    const out = await friendShares.copy(hex(f1), hex((await shareOf(f1, n2))._id));
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ _id: n2 }));
    expect((await materials.findById(out._id).lean())!.processing.status).toBe('done');
  });

  it('복사: 쪽 이미지도 사본으로 바꾸고, 올리기 한도에 닿으면 429 이고 아무것도 남기지 않는다', async () => {
    const page = `${BLOB}/uploads/image/${hex(owner)}/p.jpg`;
    await materials.updateOne(
      { _id: n1 },
      {
        kind: 'handwriting',
        blobUrls: [page],
        pages: [{ pageNo: 1, imageUrl: page, sizeBytes: 1 }],
      },
    );
    await send([n1], [f1]);
    const row = await shareOf(f1);
    const out = await friendShares.copy(hex(f1), hex(row._id));
    const copy = (await materials.findById(out._id).lean())!;
    expect(copy.pages[0]!.imageUrl).toBe(copies[0]);
    expect(copy.blobUrls).toEqual([copies[0]]);
    expect(blobs.copyUpload).toHaveBeenCalledTimes(1);

    reserve.mockImplementation(() => ({ ok: false, retryAfterMs: 5000 }));
    await expect(friendShares.copy(hex(f1), hex(row._id))).rejects.toMatchObject({ status: 429 });
    expect(await materials.countDocuments({ ownerId: f1 })).toBe(1);
    expect(await jobs.countDocuments({ userId: f1 })).toBe(1);
  });
});
