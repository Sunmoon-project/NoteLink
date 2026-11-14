// 진짜 MongoDB에서 폴더 목록의 자료 수 집계와 그 색인을 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/folders-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    service = new FoldersService(folders, materials, subjects);
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
});
