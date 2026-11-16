// 진짜 MongoDB에서 노트를 스터디룸에 공유하고 · 공유 자료를 보고 · 공유받은 멤버가 노트를 읽는 흐름을 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/materials-share-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MaterialSharingService,
  SHARED_ITEMS_MAX,
} from '../src/modules/content/materials/material-sharing.service.js';
import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import { MaterialsController } from '../src/modules/content/materials/materials.controller.js';
import { MaterialsService } from '../src/modules/content/materials/materials.service.js';
import { Folder, FolderSchema } from '../src/modules/content/schemas/folder.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import {
  RoomSharedItem,
  RoomSharedItemSchema,
} from '../src/modules/studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_share_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 노트 공유', () => {
  let conn: Connection;
  let materials: Model<Material>;
  let rooms: Model<StudyRoom>;
  let items: Model<RoomSharedItem>;
  let users: Model<User>;
  let folders: Model<Folder>;
  let jobs: Model<AiJob>;
  let materialsService: MaterialsService;
  let controller: MaterialsController;
  let sharing: MaterialSharingService;
  const owner = new Types.ObjectId();
  const friend = new Types.ObjectId();
  const stranger = new Types.ObjectId();
  const folderId = new Types.ObjectId();
  let seq = 0;

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    rooms = conn.model(StudyRoom.name, StudyRoomSchema) as unknown as Model<StudyRoom>;
    items = conn.model(
      RoomSharedItem.name,
      RoomSharedItemSchema,
    ) as unknown as Model<RoomSharedItem>;
    users = conn.model(User.name, UserSchema) as unknown as Model<User>;
    folders = conn.model(Folder.name, FolderSchema) as unknown as Model<Folder>;
    jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    await Promise.all([materials.syncIndexes(), rooms.syncIndexes(), items.syncIndexes()]);
    sharing = new MaterialSharingService(
      materials as never,
      rooms as never,
      items as never,
      users as never,
    );
    // 공유받은 멤버의 읽기: 노트 서비스는 진짜 DB 로, 저장소 · 퀴즈 미리 만들기만 대역
    materialsService = new MaterialsService(
      materials as never,
      folders as never,
      new AiJobsService(jobs as never),
      {
        createReadAccess: vi.fn((u: string) =>
          Promise.resolve({ readUrl: `${u}?sig=SECRET`, sizeBytes: 100 }),
        ),
      } as never,
      { pregenerate: vi.fn() } as never,
      conn,
    );
    controller = new MaterialsController(materialsService, sharing);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    await Promise.all([
      materials.deleteMany({}),
      rooms.deleteMany({}),
      items.deleteMany({}),
      users.deleteMany({}),
      jobs.deleteMany({}),
    ]);
  });

  const note = async (over: Record<string, unknown> = {}) =>
    (
      await materials.create({
        ownerId: owner,
        folderId,
        kind: 'handwriting',
        source: 'camera',
        title: `노트${++seq}`,
        processing: { status: 'done', progress: 100, jobId: null },
        ...over,
      })
    )._id.toHexString();
  const room = async (members: { userId: Types.ObjectId; status: string }[]) =>
    (
      (await rooms.create({
        title: `방${++seq}`,
        categoryId: new Types.ObjectId(),
        hostId: owner,
        inviteCode: `code${seq}`,
        members: members.map((m) => ({ ...m, role: 'member' })),
      } as never)) as unknown as { _id: Types.ObjectId }
    )._id.toHexString();
  const joined = (userId: Types.ObjectId) => ({ userId, status: 'joined' });
  const share = (userId: Types.ObjectId, materialIds: string[], roomId: string) =>
    sharing.share(userId.toHexString(), { materialIds, target: { type: 'room', id: roomId } });
  const saved = () => items.find({}).lean();

  describe('공유하기', () => {
    it('내 노트를 내가 멤버인 방에 공유하면 노트마다 항목이 저장된다', async () => {
      const a = await note();
      const b = await note();
      const roomId = await room([joined(owner), joined(friend)]);
      await share(owner, [a, b, a.toUpperCase()], roomId); // 같은 id 는 하나로
      const rows = await saved();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        itemType: 'material',
        sharedBy: owner,
        folderId,
        questionIds: [],
        flashcardIds: [],
        deletedAt: null,
      });
      expect(rows[0]!.roomId.toHexString()).toBe(roomId);
      expect((rows[0] as { createdAt?: Date }).createdAt).toBeInstanceOf(Date);
    });

    it('같은 노트를 다시 공유하거나 동시에 여러 번 공유해도 하나', async () => {
      const a = await note();
      const roomId = await room([joined(owner)]);
      await share(owner, [a], roomId);
      await share(owner, [a], roomId);
      expect(await saved()).toHaveLength(1);
      const b = await note();
      await Promise.all([1, 2, 3, 4, 5].map(() => share(owner, [b], roomId)));
      expect(await saved()).toHaveLength(2);
    });

    it('이미 지운 공유(deletedAt)가 있으면 새로 공유할 수 있다', async () => {
      const a = await note();
      const roomId = await room([joined(owner)]);
      await share(owner, [a], roomId);
      await items.updateMany({}, { $set: { deletedAt: new Date() } });
      await share(owner, [a], roomId);
      expect(await saved()).toHaveLength(2);
    });

    it('남의 노트가 하나라도 섞이면 404이고 아무것도 저장하지 않는다', async () => {
      const mine = await note();
      const theirs = await note({ ownerId: stranger });
      const roomId = await room([joined(owner)]);
      await expect(share(owner, [mine, theirs], roomId)).rejects.toMatchObject({ status: 404 });
      expect(await saved()).toEqual([]);
    });

    it('지운 노트 · 없는 노트가 섞여도 404이고 아무것도 저장하지 않는다', async () => {
      const mine = await note();
      const gone = await note({ deletedAt: new Date() });
      const roomId = await room([joined(owner)]);
      await expect(share(owner, [mine, gone], roomId)).rejects.toMatchObject({ status: 404 });
      await expect(
        share(owner, [mine, new Types.ObjectId().toHexString()], roomId),
      ).rejects.toMatchObject({ status: 404 });
      expect(await saved()).toEqual([]);
    });

    it('방이 없거나 내가 현재 멤버가 아니면 404 (나감 · 강퇴 · 초대만 받음 · 닫힌 방 포함)', async () => {
      const a = await note();
      const cases = [
        new Types.ObjectId().toHexString(),
        await room([joined(friend)]),
        await room([{ userId: owner, status: 'left' }]),
        await room([{ userId: owner, status: 'kicked' }]),
        await room([{ userId: owner, status: 'invited' }]),
      ];
      const closed = await room([joined(owner)]);
      await rooms.updateOne({ _id: closed }, { $set: { closedAt: new Date() } });
      cases.push(closed);
      for (const roomId of cases)
        await expect(share(owner, [a], roomId)).rejects.toMatchObject({ status: 404 });
      expect(await saved()).toEqual([]);
    });

    it('친구에게 공유는 400 VALIDATION_FAILED 이고 아무것도 저장하지 않는다', async () => {
      const a = await note();
      await expect(
        sharing.share(owner.toHexString(), {
          materialIds: [a],
          target: { type: 'friend', id: friend.toHexString() },
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDATION_FAILED', message: '친구에게 공유는 아직 지원하지 않아요' },
      });
      expect(await saved()).toEqual([]);
    });

    it('부분 unique 인덱스가 있다(같은 방 · 같은 노트 · 지우지 않은 것)', async () => {
      const idx = (await items.collection.indexes()).find((i) => i.name === 'room_material_unique');
      expect(idx).toMatchObject({
        unique: true,
        partialFilterExpression: { itemType: 'material', deletedAt: null },
      });
    });
  });
  describe('공유 자료 조회', () => {
    const person = async (nickname: string, over: Record<string, unknown> = {}) => {
      const _id = new Types.ObjectId();
      await users.collection.insertOne({ _id, nickname, deletedAt: null, ...over });
      return _id;
    };
    const list = (userId: Types.ObjectId, roomId: string) =>
      sharing.listRoomItems(userId.toHexString(), roomId);

    it('다른 멤버가 보면 공유한 노트가 최신순으로, 노트의 현재 제목과 공유한 사람 닉네임으로 보인다', async () => {
      const sharer = await person('공유왕');
      const a = await note({ ownerId: sharer, title: '처음 제목' });
      const b = await note({ ownerId: sharer, title: '두번째' });
      const roomId = await room([joined(sharer), joined(friend)]);
      await share(sharer, [a], roomId);
      await share(sharer, [b], roomId);
      await materials.updateOne({ _id: a }, { $set: { title: '바뀐 제목' } });
      const res = await list(friend, roomId);
      expect(res.flashcards).toEqual([]);
      expect(res.items.map((i) => i.title)).toEqual(['두번째', '바뀐 제목']);
      expect(res.items[0]).toEqual({
        _id: expect.any(String),
        roomId,
        sharedBy: sharer.toHexString(),
        sharedByNickname: '공유왕',
        itemType: 'material',
        quizSetId: null,
        folderId: folderId.toHexString(),
        materialId: b,
        questionIds: [],
        flashcardIds: [],
        title: '두번째',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
    });

    it('공유한 사람이 탈퇴해 닉네임을 찾을 수 없으면 대체 문구', async () => {
      const gone = await person('탈퇴자', { deletedAt: new Date() });
      const a = await note({ ownerId: gone });
      const roomId = await room([joined(gone), joined(friend)]);
      await share(gone, [a], roomId);
      expect((await list(friend, roomId)).items[0]?.sharedByNickname).toBe('알 수 없는 사용자');
    });

    it('노트를 지우면 목록에서 빠지고, 지운 공유(deletedAt)도 빠진다', async () => {
      const a = await note();
      const b = await note();
      const c = await note();
      const roomId = await room([joined(owner), joined(friend)]);
      await share(owner, [a, b, c], roomId);
      await materials.updateOne({ _id: a }, { $set: { deletedAt: new Date() } });
      await items.updateOne(
        { materialId: new Types.ObjectId(b) },
        { $set: { deletedAt: new Date() } },
      );
      expect((await list(friend, roomId)).items.map((i) => i.materialId)).toEqual([c]);
    });

    it('다른 방의 공유는 보이지 않는다', async () => {
      const a = await note();
      const here = await room([joined(owner), joined(friend)]);
      const there = await room([joined(owner), joined(friend)]);
      await share(owner, [a], there);
      expect((await list(friend, here)).items).toEqual([]);
    });

    it('항목은 최근 것부터 SHARED_ITEMS_MAX 개까지', async () => {
      const roomId = await room([joined(owner), joined(friend)]);
      const ids = await Promise.all(Array.from({ length: SHARED_ITEMS_MAX + 3 }, () => note()));
      await items.insertMany(
        ids.map((id, i) => ({
          roomId: new Types.ObjectId(roomId),
          sharedBy: owner,
          itemType: 'material',
          materialId: new Types.ObjectId(id),
          folderId,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        })),
      );
      const res = await list(friend, roomId);
      expect(res.items).toHaveLength(SHARED_ITEMS_MAX);
      expect(res.items[0]?.materialId).toBe(ids.at(-1));
    });

    it('퀴즈 · 플래시카드 항목은 담지 않는다', async () => {
      const roomId = await room([joined(owner), joined(friend)]);
      await items.insertMany([
        {
          roomId: new Types.ObjectId(roomId),
          sharedBy: owner,
          itemType: 'quiz',
          quizSetId: new Types.ObjectId(),
        },
        {
          roomId: new Types.ObjectId(roomId),
          sharedBy: owner,
          itemType: 'flashcards',
          flashcardIds: [new Types.ObjectId()],
        },
      ]);
      expect(await list(friend, roomId)).toEqual({ items: [], flashcards: [] });
    });

    it('멤버가 아니거나 나갔거나 강퇴됐거나 초대만 받았거나 방이 없거나 id 가 틀리면 404', async () => {
      const roomId = await room([
        joined(owner),
        { userId: friend, status: 'left' },
        { userId: stranger, status: 'kicked' },
      ]);
      const invitee = new Types.ObjectId();
      await rooms.updateOne(
        { _id: roomId },
        { $push: { members: { userId: invitee, status: 'invited', role: 'member' } } },
      );
      for (const user of [friend, stranger, invitee, new Types.ObjectId()])
        await expect(list(user, roomId)).rejects.toMatchObject({ status: 404 });
      await expect(list(owner, new Types.ObjectId().toHexString())).rejects.toMatchObject({
        status: 404,
      });
      await expect(list(owner, 'nope')).rejects.toMatchObject({ status: 404 });
      expect((await list(owner, roomId)).items).toEqual([]);
    });
  });
  describe('공유받은 멤버의 노트 읽기', () => {
    const asUser = (userId: Types.ObjectId) => ({
      user: { userId: userId.toHexString() },
      headers: {},
    });
    const open = (userId: Types.ObjectId, id: string) => controller.findOne(asUser(userId), id);
    const url = (userId: Types.ObjectId, id: string) => controller.downloadUrl(asUser(userId), id);
    const blob = `https://a.blob.core.windows.net/c/uploads/image/${owner.toHexString()}/550e8400-e29b-41d4-a716-446655440001.jpg`;

    it('공유하면 다른 멤버가 노트를 열고 원본 주소도 받는다. 서버 값은 새지 않는다', async () => {
      const a = await note({
        title: '공유 노트',
        blobUrls: [blob],
        pages: [{ pageNo: 1, imageUrl: blob, sizeBytes: 1, ocrText: null, takenAt: null }],
        bookmarks: [{ atSec: 3 }],
      });
      const roomId = await room([joined(owner), joined(friend)]);
      await share(owner, [a], roomId);
      const { data } = await open(friend, a);
      expect(data).toMatchObject({ _id: a, title: '공유 노트', bookmarks: [{ atSec: 3 }] });
      const json = JSON.stringify(data);
      expect(json).not.toContain('blobUrls');
      expect(json).not.toContain('ownerId');
      expect(json).not.toContain('requestId');
      // 이미지 주소의 업로드 경로에는 올린 사람 id 가 들어 있다(공유 목록의 sharedBy 로 이미 보이는 값)
      expect((await url(friend, a)).data).toMatchObject({ url: `${blob}?sig=SECRET` });
      // 주인은 지금처럼
      expect((await open(owner, a)).data._id).toBe(a);
    });

    it('공유받은 사람이 열면 노트 주인의 작업 기준으로 진행 상태를 옮긴다', async () => {
      const a = await note({ processing: { status: 'queued', progress: 0, jobId: null } });
      const job = await jobs.create({
        type: 'handwriting_summary',
        userId: owner,
        targetType: 'material',
        targetId: new Types.ObjectId(a),
        input: {},
        status: 'running',
        progress: 40,
      });
      await materials.updateOne({ _id: a }, { $set: { 'processing.jobId': job._id } });
      const roomId = await room([joined(owner), joined(friend)]);
      await share(owner, [a], roomId);
      const { data } = await open(friend, a);
      // 열람자의 작업으로 찾았다면 작업이 없는 것으로 보고 failed 가 됐을 것이다
      expect(data.processing).toMatchObject({ status: 'processing', progress: 40 });
    });

    it('멤버가 아니거나 나갔거나 강퇴됐거나 초대만 받았으면 노트도 원본 주소도 404', async () => {
      const a = await note({ blobUrls: [blob] });
      const invitee = new Types.ObjectId();
      const roomId = await room([
        joined(owner),
        { userId: friend, status: 'left' },
        { userId: stranger, status: 'kicked' },
        { userId: invitee, status: 'invited' },
      ]);
      await share(owner, [a], roomId);
      for (const user of [friend, stranger, invitee, new Types.ObjectId()]) {
        await expect(open(user, a)).rejects.toMatchObject({ status: 404 });
        await expect(url(user, a)).rejects.toMatchObject({ status: 404 });
      }
    });

    it('공유하지 않은 노트 · 다른 방에만 공유된 노트 · 닫힌 방 · 지운 노트 · 지운 공유는 404', async () => {
      const unshared = await note();
      const elsewhere = await note();
      const inClosed = await note();
      const deletedNote = await note();
      const unshare = await note();
      const here = await room([joined(owner), joined(friend)]);
      const there = await room([joined(owner)]);
      const closed = await room([joined(owner), joined(friend)]);
      await share(owner, [elsewhere], there);
      await share(owner, [inClosed], closed);
      await rooms.updateOne({ _id: closed }, { $set: { closedAt: new Date() } });
      await share(owner, [deletedNote, unshare], here);
      await materials.updateOne({ _id: deletedNote }, { $set: { deletedAt: new Date() } });
      await items.updateOne(
        { materialId: new Types.ObjectId(unshare) },
        { $set: { deletedAt: new Date() } },
      );
      for (const id of [unshared, elsewhere, inClosed, deletedNote, unshare, 'nope'])
        await expect(open(friend, id)).rejects.toMatchObject({ status: 404 });
    });

    it('공유받은 사람의 수정 · 삭제는 404이고 노트는 그대로', async () => {
      const a = await note({ title: '원래 제목' });
      const roomId = await room([joined(owner), joined(friend)]);
      await share(owner, [a], roomId);
      const me = friend.toHexString();
      await expect(materialsService.update(me, a, { saved: true })).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        materialsService.update(me, a, { summary: { sections: [] } }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(materialsService.remove(me, a)).rejects.toMatchObject({ status: 404 });
      const row = await materials.findById(a).lean();
      expect(row).toMatchObject({ title: '원래 제목', deletedAt: null, savedAt: null });
    });
    it('작업 없이 남은 노트를 공유받은 멤버가 열면 복구도 노트 주인 기준으로 돈다', async () => {
      const a = await note({
        blobUrls: [blob],
        pages: [{ pageNo: 1, imageUrl: blob, sizeBytes: 100, ocrText: null, takenAt: null }],
        processing: { status: 'queued', progress: 0, jobId: null },
      });
      await materials.collection.updateOne(
        { _id: new Types.ObjectId(a) },
        { $set: { createdAt: new Date(Date.now() - 120_000) } },
      );
      const roomId = await room([joined(owner), joined(friend)]);
      await share(owner, [a], roomId);
      const { data } = await open(friend, a);
      expect(data.processing.jobId).toBeTruthy();
      const made = await jobs.find({}).lean();
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({ userId: owner, type: 'handwriting_summary' });
    });
  });
});
