// 진짜 MongoDB에서 노트 등록의 멱등성 · 동시 요청 · 중단 복구를 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/materials-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import type { CreateMaterialDto } from '../src/modules/content/materials/dto/create-material.dto.js';
import { MaterialsService } from '../src/modules/content/materials/materials.service.js';
import { Folder, FolderSchema } from '../src/modules/content/schemas/folder.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_materials_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 노트 등록', () => {
  let conn: Connection;
  let materials: Model<Material>;
  let folders: Model<Folder>;
  let jobs: Model<AiJob>;
  let service: MaterialsService;
  let blobs: { createReadAccess: ReturnType<typeof vi.fn> };
  const me = new Types.ObjectId();
  const other = new Types.ObjectId();
  let folderId: string;

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    folders = conn.model(Folder.name, FolderSchema) as unknown as Model<Folder>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    await Promise.all([folders.syncIndexes(), materials.syncIndexes(), jobs.syncIndexes()]);
    blobs = {
      createReadAccess: vi.fn((u: string, _ttl: number, verify?: unknown) =>
        Promise.resolve({ readUrl: `${u}?sig=SECRET`, ...(verify ? { sizeBytes: 100 } : {}) }),
      ),
    };
    service = new MaterialsService(
      materials as never,
      folders as never,
      new AiJobsService(jobs as never),
      blobs as never,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    await Promise.all([folders.deleteMany({}), materials.deleteMany({}), jobs.deleteMany({})]);
    const f = await folders.create({ ownerId: me, title: '수학', subjectName: '수학' });
    folderId = f._id.toHexString();
  });

  const url = (n: number, user = me) =>
    `https://a.blob.core.windows.net/c/uploads/image/${user.toHexString()}/550e8400-e29b-41d4-a716-44665544000${n}.jpg`;
  const dto = (over: Partial<CreateMaterialDto> = {}): CreateMaterialDto => ({
    folderId,
    kind: 'handwriting',
    source: 'camera',
    title: '필기',
    blobUrls: [url(1)],
    ...over,
  });

  it('노트와 작업이 하나씩 생기고 서로를 가리킨다. 폴더가 맨 앞으로 온다', async () => {
    const stamp = async () =>
      (await folders.findById(folderId).lean<{ updatedAt: Date }>())!.updatedAt.getTime();
    const before = await stamp();
    const { material, job } = await service.register(me.toHexString(), dto());
    const row = await materials.findById(material._id).lean();
    expect(row?.processing.jobId?.toString()).toBe(job._id);
    expect(row?.pages?.[0]?.imageUrl).toBe(url(1));
    expect(row?.blobUrls).toEqual([url(1)]);
    const stored = await jobs.findById(job._id).lean();
    expect(stored).toMatchObject({
      type: 'handwriting_summary',
      status: 'queued',
      targetType: 'material',
    });
    expect(stored?.targetId.toString()).toBe(material._id);
    expect(JSON.stringify(row)).not.toContain('SECRET');
    expect(await stamp()).toBeGreaterThanOrEqual(before);
  });

  it('같은 키의 재요청은 같은 노트 · 같은 작업. 키 없는 요청은 매번 새로 만든다', async () => {
    const a = await service.register(me.toHexString(), dto(), 'k1');
    const b = await service.register(me.toHexString(), dto(), 'k1');
    expect(b.material._id).toBe(a.material._id);
    expect(b.job._id).toBe(a.job._id);
    expect(await materials.countDocuments()).toBe(1);
    expect(await jobs.countDocuments()).toBe(1);

    await service.register(me.toHexString(), dto());
    await service.register(me.toHexString(), dto());
    expect(await materials.countDocuments()).toBe(3);
  });

  it('같은 키에 다른 내용은 409, 다른 사용자의 같은 키는 별개', async () => {
    await service.register(me.toHexString(), dto(), 'k1');
    await expect(
      service.register(me.toHexString(), dto({ title: '다른 제목' }), 'k1'),
    ).rejects.toMatchObject({ status: 409, response: { code: 'IDEMPOTENCY_CONFLICT' } });
    await expect(
      service.register(me.toHexString(), dto({ blobUrls: [url(2)] }), 'k1'),
    ).rejects.toMatchObject({ status: 409 });

    const theirs = await folders.create({
      ownerId: other,
      title: '남의 폴더',
      subjectName: '수학',
    });
    const res = await service.register(
      other.toHexString(),
      dto({ folderId: theirs._id.toHexString(), blobUrls: [url(1, other)] }),
      'k1',
    );
    expect(res.material._id).toBeDefined();
    expect(await materials.countDocuments()).toBe(2);
  });

  it('같은 키의 동시 요청 여러 개도 노트 · 작업이 하나', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.register(me.toHexString(), dto(), 'race')),
    );
    expect(new Set(results.map((r) => r.material._id)).size).toBe(1);
    expect(new Set(results.map((r) => r.job._id)).size).toBe(1);
    expect(await materials.countDocuments()).toBe(1);
    // 겹쳐서 더 넣은 작업은 취소돼 처리기가 가져가지 않는다
    const queued = await jobs.find({ status: 'queued' }).lean();
    expect(queued).toHaveLength(1);
    expect(queued[0]!._id.toString()).toBe(results[0]!.job._id);
  });

  it('작업을 넣기 전에 멈춘 노트는 같은 키의 재요청이 작업을 마저 넣는다', async () => {
    // 노트만 만들고 멈춘 상태를 만든다
    const { fingerprintOf } = await import('../src/modules/content/materials/materials.service.js');
    const stuck = await materials.create({
      ownerId: me,
      folderId: new Types.ObjectId(folderId),
      kind: 'handwriting',
      source: 'camera',
      title: '필기',
      description: null,
      avatarItemId: null,
      processing: { status: 'queued', progress: 0, jobId: null },
      pages: [{ pageNo: 1, imageUrl: url(1), sizeBytes: 100, ocrText: null, takenAt: null }],
      blobUrls: [url(1)],
      requestId: 'stuck',
      requestFingerprint: fingerprintOf({
        folderId,
        kind: 'handwriting',
        source: 'camera',
        title: '필기',
        description: null,
        blobUrls: [url(1)],
        avatarItemId: null,
      }),
    });
    const res = await service.register(me.toHexString(), dto(), 'stuck');
    expect(res.material._id).toBe(stuck._id.toHexString());
    expect(res.job.targetId).toBe(stuck._id.toHexString());
    expect((await materials.findById(stuck._id).lean())?.processing.jobId?.toString()).toBe(
      res.job._id,
    );
    expect(await jobs.countDocuments()).toBe(1);
  });

  it('지운 노트의 키로 다시 요청하면 409 (되살리지 않는다)', async () => {
    const a = await service.register(me.toHexString(), dto(), 'gone');
    await materials.updateOne({ _id: a.material._id }, { $set: { deletedAt: new Date() } });
    await expect(service.register(me.toHexString(), dto(), 'gone')).rejects.toMatchObject({
      status: 409,
      response: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(await jobs.countDocuments()).toBe(1);
  });

  it('남의 폴더 · 지운 폴더는 404이고 노트 · 작업이 생기지 않는다', async () => {
    const theirs = await folders.create({
      ownerId: other,
      title: '남의 폴더',
      subjectName: '수학',
    });
    const gone = await folders.create({
      ownerId: me,
      title: '지운 폴더',
      subjectName: '수학',
      deletedAt: new Date(),
    });
    for (const id of [theirs._id, gone._id]) {
      await expect(
        service.register(me.toHexString(), dto({ folderId: id.toHexString() })),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(await materials.countDocuments()).toBe(0);
    expect(await jobs.countDocuments()).toBe(0);
  });

  it('requestId 없는 노트끼리는 unique 색인에 걸리지 않는다', async () => {
    await materials.create({
      ownerId: me,
      folderId: new Types.ObjectId(folderId),
      kind: 'recording',
      source: 'audio_file',
      title: 'a',
      processing: { status: 'queued', progress: 0 },
    });
    await materials.create({
      ownerId: me,
      folderId: new Types.ObjectId(folderId),
      kind: 'recording',
      source: 'audio_file',
      title: 'b',
      processing: { status: 'queued', progress: 0 },
    });
    expect(await materials.countDocuments()).toBe(2);
  });
});
