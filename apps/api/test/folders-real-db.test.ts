// 진짜 MongoDB에서 폴더 목록의 자료 수 집계 · 색인, 폴더 삭제 트랜잭션을 보는 테스트(삭제는 replica set 필요).
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/folders-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FoldersService } from '../src/modules/content/folders/folders.service.js';
import { Folder, FolderSchema } from '../src/modules/content/schemas/folder.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_folders_${process.pid}_${Date.now()}`;

/** 실행 계획에서 쓰인 단계 이름을 모두 모은다 */
function stages(plan: unknown, found: string[] = []): string[] {
  if (plan && typeof plan === 'object') {
    for (const [key, value] of Object.entries(plan)) {
      if (key === 'stage' && typeof value === 'string') found.push(value);
      else stages(value, found);
    }
  }
  return found;
}

describe.skipIf(!uri)('진짜 DB 학습 폴더 확인', () => {
  let conn: Connection;
  let service: FoldersService;
  let materials: Model<Material>;
  const me = new Types.ObjectId();
  const other = new Types.ObjectId();

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    const folders = conn.model(Folder.name, FolderSchema) as unknown as Model<Folder>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    const subjects = conn.model(Subject.name, SubjectSchema) as unknown as Model<Subject>;
    await Promise.all([folders.syncIndexes(), materials.syncIndexes()]);
    await conn.collection('subjects').insertOne({ name: '수학', color: '#000000', isActive: true });
    service = new FoldersService(folders, materials, subjects, conn);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  const material = (folderId: string, over: Record<string, unknown> = {}) => ({
    ownerId: me,
    folderId: new Types.ObjectId(folderId),
    deletedAt: null,
    ...over,
  });

  it('만들고 목록을 읽는다: 과목 ID · 최근에 바뀐 순 · 지우지 않은 내 자료 수', async () => {
    const math = await service.create(me.toHexString(), { title: ' 미적분 ', subjectName: '수학' });
    const etc = await service.create(me.toHexString(), { title: '운영체제', subjectName: '기타' });
    await service.create(other.toHexString(), { title: '남의 폴더', subjectName: '수학' });
    expect(math.subjectId).toMatch(/^[0-9a-f]{24}$/);
    expect(etc).toMatchObject({ subjectId: null, subjectName: '기타' });

    await conn
      .collection('materials')
      .insertMany([
        material(math._id),
        material(math._id),
        material(math._id, { deletedAt: new Date() }),
        material(math._id, { ownerId: other }),
      ]);

    const list = await service.list(me.toHexString());

    expect(list.map((f) => [f.title, f.materialCount])).toEqual([
      ['운영체제', 0],
      ['미적분', 2],
    ]);
    expect(list[1]).toMatchObject({
      _id: math._id,
      subjectId: math.subjectId,
      subjectName: '수학',
    });
  });

  it('자료 수 집계는 컬렉션 전체를 훑지 않고 색인을 쓴다', async () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    const plan = await materials
      .aggregate([
        { $match: { ownerId: me, folderId: { $in: ids }, deletedAt: null } },
        { $group: { _id: '$folderId', count: { $sum: 1 } } },
      ])
      .explain('queryPlanner');

    const used = stages(plan);
    expect(used).toContain('IXSCAN');
    expect(used).not.toContain('COLLSCAN');
  });
  describe('폴더 삭제 (트랜잭션)', () => {
    const folderRow = async (id: string) =>
      conn.collection('folders').findOne({ _id: new Types.ObjectId(id) });
    const materialRow = (id: unknown) =>
      conn.collection('materials').findOne({ _id: id as Types.ObjectId });

    it('폴더와 안의 지우지 않은 노트를 함께 지운다. 이미 지운 노트의 시각 · 다른 폴더 · 남의 노트는 그대로', async () => {
      const target = await service.create(me.toHexString(), {
        title: '지울 폴더',
        subjectName: '수학',
      });
      const keep = await service.create(me.toHexString(), {
        title: '남길 폴더',
        subjectName: '수학',
      });
      const longAgo = new Date('2026-01-01T00:00:00.000Z');
      const inserted = await conn
        .collection('materials')
        .insertMany([
          material(target._id),
          material(target._id),
          material(target._id, { deletedAt: longAgo }),
          material(keep._id),
          material(target._id, { ownerId: other }),
        ]);
      const ids = Object.values(inserted.insertedIds);

      await service.remove(me.toHexString(), target._id);

      expect((await folderRow(target._id))?.deletedAt).toBeInstanceOf(Date);
      expect((await materialRow(ids[0]))?.deletedAt).toBeInstanceOf(Date);
      expect((await materialRow(ids[1]))?.deletedAt).toBeInstanceOf(Date);
      expect((await materialRow(ids[2]))?.deletedAt).toEqual(longAgo);
      expect((await materialRow(ids[3]))?.deletedAt).toBeNull();
      expect((await materialRow(ids[4]))?.deletedAt).toBeNull();
      expect((await folderRow(keep._id))?.deletedAt).toBeNull();
      // 목록에서도 사라진다
      const titles = (await service.list(me.toHexString())).map((f) => f.title);
      expect(titles).toContain('남길 폴더');
      expect(titles).not.toContain('지울 폴더');
    });

    it('노트를 지우다 실패하면 폴더도 지워지지 않는다(롤백)', async () => {
      const f = await service.create(me.toHexString(), { title: '롤백 폴더', subjectName: '수학' });
      const inserted = await conn.collection('materials').insertOne(material(f._id));
      const spy = vi.spyOn(materials, 'updateMany').mockRejectedValueOnce(new Error('boom'));

      await expect(service.remove(me.toHexString(), f._id)).rejects.toThrow('boom');

      spy.mockRestore();
      expect((await folderRow(f._id))?.deletedAt).toBeNull();
      expect((await materialRow(inserted.insertedId))?.deletedAt).toBeNull();
    });

    it('남의 폴더 · 지운 폴더 · 없는 폴더 · 잘못된 id 는 404이고 아무것도 바꾸지 않는다', async () => {
      const theirs = await service.create(other.toHexString(), {
        title: '남의 폴더',
        subjectName: '수학',
      });
      const inserted = await conn
        .collection('materials')
        .insertOne(material(theirs._id, { ownerId: other }));
      const mine = await service.create(me.toHexString(), {
        title: '이미 지움',
        subjectName: '수학',
      });
      await service.remove(me.toHexString(), mine._id);

      for (const id of [theirs._id, mine._id, new Types.ObjectId().toHexString(), 'nope', '../x']) {
        await expect(service.remove(me.toHexString(), id)).rejects.toMatchObject({
          status: 404,
          response: { code: 'NOT_FOUND' },
        });
      }
      expect((await folderRow(theirs._id))?.deletedAt).toBeNull();
      expect((await materialRow(inserted.insertedId))?.deletedAt).toBeNull();
    });
  });
});
