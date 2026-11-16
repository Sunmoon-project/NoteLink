// 진짜 MongoDB에서 노트를 스터디룸에 공유하고 · 공유 자료를 보고 · 공유받은 멤버가 노트를 읽는 흐름을 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/materials-share-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MaterialSharingService } from '../src/modules/content/materials/material-sharing.service.js';
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
    await Promise.all([materials.syncIndexes(), rooms.syncIndexes(), items.syncIndexes()]);
    sharing = new MaterialSharingService(materials as never, rooms as never, items as never);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    await Promise.all([materials.deleteMany({}), rooms.deleteMany({}), items.deleteMany({})]);
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
});
