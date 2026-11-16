// 진짜 MongoDB에서 노트 등록의 멱등성 · 동시 요청 · 중단 복구를 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/materials-real-db.test.ts
import { BadRequestException } from '@nestjs/common';
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import { FoldersService } from '../src/modules/content/folders/folders.service.js';
import {
  decodeCursor,
  encodeCursor,
  type ListCursor,
} from '../src/modules/content/materials/list-cursor.js';
import type { CreateMaterialDto } from '../src/modules/content/materials/dto/create-material.dto.js';
import {
  CLAIM_TTL_MS,
  fingerprintOf,
  BOOKMARK_MAX,
  LIST_SYNC_MAX,
  MaterialsService,
} from '../src/modules/content/materials/materials.service.js';
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
  let aiJobs: AiJobsService;
  let blobs: { createReadAccess: ReturnType<typeof vi.fn> };
  const quizSets = { pregenerate: vi.fn() };
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
    aiJobs = new AiJobsService(jobs as never);
    service = new MaterialsService(
      materials as never,
      folders as never,
      aiJobs,
      blobs as never,
      quizSets as never,
      conn,
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

  /** 작업 id 를 노트에 연결하는 첫 호출만 예외로 끝낸다(그 밖의 호출은 그대로) */
  const failLinkOnce = () => {
    const original = materials.findOneAndUpdate.bind(materials);
    let failed = false;
    const spy = vi.spyOn(materials, 'findOneAndUpdate').mockImplementation(((
      f: unknown,
      u: { $set?: Record<string, unknown> },
      o: unknown,
    ) => {
      if (!failed && u?.$set?.['processing.jobId']) {
        failed = true;
        return { lean: () => Promise.reject(new Error('link failed')) };
      }
      return original(f as never, u as never, o as never);
    }) as never);
    return () => spy.mockRestore();
  };
  const url = (n: number, user = me) =>
    `https://a.blob.core.windows.net/c/uploads/image/${user.toHexString()}/550e8400-e29b-41d4-a716-44665544000${n}.jpg`;
  const docUrl = `https://a.blob.core.windows.net/c/uploads/document/${me.toHexString()}/550e8400-e29b-41d4-a716-446655440007.pdf`;
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

  it('작업을 넣은 뒤 서버가 멈춰 취소하지 못한 작업은 그대로 남고(다음 요청이 취소하지 않는다), 같은 키의 다시 요청은 새 작업을 만들어 연결한다', async () => {
    // 서버가 연결 도중 멈춘 상황: 연결도 취소도 하지 못한다
    const restore = failLinkOnce();
    const cancel = vi.spyOn(AiJobsService.prototype, 'cancel').mockRejectedValue(new Error('down'));
    await expect(service.register(me.toHexString(), dto(), 'half')).rejects.toThrow('link failed');
    restore();
    cancel.mockRestore();
    // 작업은 들어갔고 노트에는 연결되지 않은 상태
    const stuck = await materials.findOne({ requestId: 'half' }).lean();
    expect(stuck?.processing.jobId).toBeNull();
    const [left] = await jobs.find({ targetId: stuck!._id }).lean();
    expect(left?.status).toBe('queued');

    const again = await service.register(me.toHexString(), dto(), 'half');

    // 남은 작업은 그대로 남고(다음 요청이 남의 작업을 취소하지 않는다) 새 작업이 노트에 연결된다
    expect(again.job._id).not.toBe(left!._id.toString());
    expect((await jobs.findById(left!._id).lean())?.status).toBe('queued');
    expect(await jobs.countDocuments({ targetId: stuck!._id })).toBe(2);
    expect(await jobs.countDocuments({ status: 'canceled' })).toBe(0);
    expect((await materials.findById(stuck!._id).lean())?.processing.jobId?.toString()).toBe(
      again.job._id,
    );
    // 한 번 더 요청해도 연결된 작업을 돌려줄 뿐 작업이 늘지 않는다
    const third = await service.register(me.toHexString(), dto(), 'half');
    expect(third.job._id).toBe(again.job._id);
    expect(await jobs.countDocuments()).toBe(2);
  });

  it('이어 쓸 작업이 취소된 것뿐이면 새로 넣는다. 다른 종류 · 다른 노트의 작업은 이어 쓰지 않는다', async () => {
    const stuck = await materials.create({
      ownerId: me,
      folderId: new Types.ObjectId(folderId),
      kind: 'handwriting',
      source: 'camera',
      title: '필기',
      processing: { status: 'queued', progress: 0, jobId: null },
      pages: [],
      blobUrls: [url(1)],
    });
    const base = {
      userId: me,
      targetType: 'material',
      progress: 0,
      attempts: 0,
      result: null,
      input: {},
    };
    await jobs.create({
      ...base,
      type: 'handwriting_summary',
      targetId: stuck._id,
      status: 'canceled',
    });
    await jobs.create({ ...base, type: 'quiz_pregen', targetId: stuck._id, status: 'queued' });
    await jobs.create({
      ...base,
      type: 'handwriting_summary',
      targetId: new Types.ObjectId(),
      status: 'queued',
    });
    const { AiJobsService: Jobs } = await import('../src/ai-jobs/ai-jobs.service.js');
    const lookup = new Jobs(jobs as never);
    const query = {
      type: 'handwriting_summary',
      targetType: 'material',
      targetId: stuck._id.toHexString(),
    };

    expect(await lookup.findForTarget(me.toHexString(), query)).toBeNull();
    expect(
      await lookup.findForTarget(other.toHexString(), { ...query, type: 'quiz_pregen' }),
    ).toBeNull();
    const failed = await jobs.create({
      ...base,
      type: 'handwriting_summary',
      targetId: stuck._id,
      status: 'failed',
    });
    expect((await lookup.findForTarget(me.toHexString(), query))?._id).toBe(
      failed._id.toHexString(),
    );
  });

  it('폴더 삭제와 등록이 겹쳐도 지운 폴더 안에 살아 있는 노트가 남지 않는다', async () => {
    const folderService = new FoldersService(
      folders as never,
      materials as never,
      {} as never,
      conn,
    );
    let registered = 0;
    let rejected = 0;
    for (let i = 0; i < 25; i++) {
      const f = await folders.create({ ownerId: me, title: '겹침 ' + i, subjectName: '수학' });
      const id = f._id.toHexString();
      const [made, removed] = await Promise.allSettled([
        service.register(me.toHexString(), dto({ folderId: id }), 'race-' + i),
        folderService.remove(me.toHexString(), id),
      ]);
      // 폴더 삭제는 늘 성공, 등록은 성공하거나 404(지운 폴더)
      expect(removed.status).toBe('fulfilled');
      if (made.status === 'fulfilled') registered += 1;
      else {
        rejected += 1;
        expect(made.reason).toMatchObject({ status: 404 });
      }
      expect((await folders.findById(f._id).lean())?.deletedAt).toBeInstanceOf(Date);
      expect(
        await materials.countDocuments({ folderId: f._id, deletedAt: null }),
        '반복 ' + i + ': 지운 폴더 안에 살아 있는 노트',
      ).toBe(0);
    }
    expect(registered + rejected).toBe(25);
  });

  it('이미 지운 폴더에는 등록하지 못하고(404) 노트 · 작업이 생기지 않는다', async () => {
    await folders.updateOne({ _id: folderId }, { $set: { deletedAt: new Date() } });
    await expect(service.register(me.toHexString(), dto())).rejects.toMatchObject({ status: 404 });
    expect(await materials.countDocuments()).toBe(0);
    expect(await jobs.countDocuments()).toBe(0);
  });

  describe('작업 만들기 경쟁 (작업 만드는 중 표시)', () => {
    /** 작업 id 없이 멈춘 노트(노트만 만들고 작업을 넣기 전에 멈춘 상태) */
    const stuckNote = async (key: string, over: Record<string, unknown> = {}) =>
      materials.create({
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
        requestId: key,
        requestFingerprint: fingerprintOf({
          folderId,
          kind: 'handwriting',
          source: 'camera',
          title: '필기',
          description: null,
          blobUrls: [url(1)],
          avatarItemId: null,
        }),
        ...over,
      });

    it('같은 노트로 동시 요청이 여러 개이고 그중 하나의 연결이 실패해도, 연결된 작업 1개만 살아 있다', async () => {
      const note = await stuckNote('gate');
      // 작업을 만드는 곳(enqueue)에서 요청들이 동시에 들어오게 맞춘다. 표시를 잡은 하나만 들어오므로 시간 제한(300ms)이 지나면 풀린다
      const enqueue = AiJobsService.prototype.enqueue;
      let arrived = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const timer = setTimeout(open, 300);
      vi.spyOn(AiJobsService.prototype, 'enqueue').mockImplementation(async function (
        this: AiJobsService,
        ...args: Parameters<typeof enqueue>
      ) {
        arrived += 1;
        if (arrived >= 2) open();
        if (arrived <= 2) await gate;
        return enqueue.apply(this, args);
      });
      const restore = failLinkOnce();

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.register(me.toHexString(), dto(), 'gate')),
      );
      restore();
      clearTimeout(timer);
      vi.mocked(AiJobsService.prototype.enqueue).mockRestore();

      const alive = await jobs.find({ targetId: note._id, status: { $ne: 'canceled' } }).lean();
      expect(alive).toHaveLength(1);
      expect((await materials.findById(note._id).lean())?.processing.jobId?.toString()).toBe(
        alive[0]!._id.toString(),
      );
      // 나머지 작업은 없거나 취소 상태다
      expect(await jobs.countDocuments({ targetId: note._id, status: 'queued' })).toBe(1);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(3);
      for (const r of fulfilled) {
        expect((r as PromiseFulfilledResult<{ job: { _id: string } }>).value.job._id).toBe(
          alive[0]!._id.toString(),
        );
      }
    });

    it('작업을 넣은 뒤 연결에서 예외가 나면 그 작업을 취소하고 표시를 풀어, 다음 요청이 새로 이어간다', async () => {
      const restore = failLinkOnce();
      await expect(service.register(me.toHexString(), dto(), 'once')).rejects.toThrow(
        'link failed',
      );
      restore();
      const note = (await materials.findOne({ requestId: 'once' }).lean())!;
      expect(note.processing.jobId).toBeNull();
      expect(note.jobClaimToken).toBeUndefined();
      expect(note.jobClaimedAt).toBeUndefined();
      expect(await jobs.countDocuments({ targetId: note._id, status: 'canceled' })).toBe(1);
      expect(await jobs.countDocuments({ targetId: note._id, status: 'queued' })).toBe(0);

      const again = await service.register(me.toHexString(), dto(), 'once');

      expect(await jobs.countDocuments({ targetId: note._id, status: { $ne: 'canceled' } })).toBe(
        1,
      );
      expect((await materials.findById(note._id).lean())?.processing.jobId?.toString()).toBe(
        again.job._id,
      );
    });

    it('다른 요청이 작업을 만드는 중(표시가 유효)이면 작업을 만들지 않고 기다리다 503', async () => {
      const note = await stuckNote('busy', { jobClaimToken: 'other', jobClaimedAt: new Date() });

      await expect(service.register(me.toHexString(), dto(), 'busy')).rejects.toMatchObject({
        status: 503,
        response: { code: 'REGISTRATION_IN_PROGRESS' },
      });

      expect(await jobs.countDocuments({ targetId: note._id })).toBe(0);
      const row = await materials.findById(note._id).lean();
      expect(row?.jobClaimToken).toBe('other');
    });

    it('기다리는 동안 다른 요청이 연결하면 그 작업을 돌려준다', async () => {
      const note = await stuckNote('wait', { jobClaimToken: 'other', jobClaimedAt: new Date() });
      const made = await jobs.create({
        userId: me,
        type: 'handwriting_summary',
        targetType: 'material',
        targetId: note._id,
        input: {},
        status: 'queued',
        progress: 0,
        attempts: 0,
        result: null,
      });
      setTimeout(() => {
        void materials
          .updateOne(
            { _id: note._id },
            {
              $set: { 'processing.jobId': made._id },
              $unset: { jobClaimToken: '', jobClaimedAt: '' },
            },
          )
          .exec();
      }, 400);

      const res = await service.register(me.toHexString(), dto(), 'wait');

      expect(res.job._id).toBe(made._id.toHexString());
      expect(await jobs.countDocuments({ targetId: note._id })).toBe(1);
    });

    it('서버가 멈춰 남은 표시는 시간이 지나면 다른 요청이 다시 잡아 이어간다', async () => {
      const note = await stuckNote('expired', {
        jobClaimToken: 'dead',
        jobClaimedAt: new Date(Date.now() - 2 * CLAIM_TTL_MS),
      });

      const res = await service.register(me.toHexString(), dto(), 'expired');

      const row = await materials.findById(note._id).lean();
      expect(row?.processing.jobId?.toString()).toBe(res.job._id);
      expect(row?.jobClaimToken).toBeUndefined();
      expect(await jobs.countDocuments({ targetId: note._id })).toBe(1);
    });

    /** 표시 인계 테스트 공통: 요청 A 가 표시를 잡고 작업을 만든 뒤 연결에 실패하고, 표시가 만료돼 B 가 표시를 가져간다 */
    const defer = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    };
    /** 표시를 잡은 순서대로 토큰을 기억한다(첫째는 A, 둘째는 B). A 의 연결은 예외, B 의 연결은 beforeBLink 가 풀릴 때까지 멈춘다 */
    const hookLinks = (beforeBLink?: () => Promise<void>) => {
      const tokens: string[] = [];
      const original = materials.findOneAndUpdate.bind(materials);
      const spy = vi.spyOn(materials, 'findOneAndUpdate').mockImplementation(((
        f: { jobClaimToken?: string },
        u: { $set?: Record<string, string> },
        o: unknown,
      ) => {
        const claimToken = u?.$set?.['jobClaimToken'];
        if (claimToken) tokens.push(claimToken);
        if (u?.$set?.['processing.jobId']) {
          if (f.jobClaimToken === tokens[0])
            return { lean: () => Promise.reject(new Error('link failed (A)')) };
          return {
            lean: async () => {
              await beforeBLink?.();
              return original(f as never, u as never, o as never).lean();
            },
          };
        }
        return original(f as never, u as never, o as never);
      }) as never);
      return { tokens, restore: () => spy.mockRestore() };
    };
    /** 첫 enqueue 가 끝난 직후(A 가 작업을 만든 직후) 멈춘다 */
    const pauseAfterFirstEnqueue = (entered: () => void, gate: Promise<void>) => {
      const enqueue = AiJobsService.prototype.enqueue;
      let calls = 0;
      return vi.spyOn(AiJobsService.prototype, 'enqueue').mockImplementation(async function (
        this: AiJobsService,
        ...args: Parameters<typeof enqueue>
      ) {
        const job = await enqueue.apply(this, args);
        calls += 1;
        if (calls === 1) {
          entered();
          await gate;
        }
        return job;
      });
    };
    const expireClaim = (noteId: Types.ObjectId) =>
      materials.updateOne(
        { _id: noteId },
        { $set: { jobClaimedAt: new Date(Date.now() - 2 * CLAIM_TTL_MS) } },
      );

    it('표시가 만료돼 다른 요청이 가져간 뒤 늦게 실패한 요청은 자기 작업만 취소하고, 상대의 작업 · 표시는 건드리지 않는다', async () => {
      const note = await stuckNote('late');
      const aEnqueued = defer();
      const gateA = defer();
      const bAtLink = defer();
      const gateB = defer();
      const enqueueSpy = pauseAfterFirstEnqueue(aEnqueued.resolve, gateA.promise);
      const links = hookLinks(async () => {
        bAtLink.resolve();
        await gateB.promise;
      });
      const cancelSpy = vi.spyOn(AiJobsService.prototype, 'cancel');

      try {
        const a = service.register(me.toHexString(), dto(), 'late').then(
          () => null,
          (e: Error) => e,
        );
        await aEnqueued.promise;
        await expireClaim(note._id); // A 의 표시가 만료된다
        // B 가 표시를 가져가 자기 작업을 만들고 연결 직전에 멈춘다(A 의 작업을 이어 쓰지 않는다)
        const b = service.register(me.toHexString(), dto(), 'late');
        await bAtLink.promise;
        expect(links.tokens).toHaveLength(2);
        expect(await jobs.countDocuments({ targetId: note._id })).toBe(2);

        // A 가 늦게 실패한다
        gateA.resolve();
        expect((await a)?.message).toBe('link failed (A)');
        const [jobA, jobB] = await jobs.find({ targetId: note._id }).sort({ _id: 1 }).lean();
        // A 는 자기 작업만 스스로 취소했고, B 의 작업 · 표시는 그대로다
        expect(cancelSpy.mock.calls.map((c) => c[1])).toEqual([jobA!._id.toString()]);
        expect(jobA!.status).toBe('canceled');
        expect(jobB!.status).toBe('queued');
        expect((await materials.findById(note._id).lean())?.jobClaimToken).toBe(links.tokens[1]);

        // B 가 마저 연결한다
        gateB.resolve();
        const done = await b;
        expect(done.job._id).toBe(jobB!._id.toString());
        const row = await materials.findById(note._id).lean();
        expect(row?.processing.jobId?.toString()).toBe(jobB!._id.toString());
        expect(row?.jobClaimToken).toBeUndefined();
        expect((await jobs.findById(jobB!._id).lean())?.status).toBe('queued');
        expect(await jobs.countDocuments({ targetId: note._id })).toBe(2);
        expect(await jobs.countDocuments({ targetId: note._id, status: 'canceled' })).toBe(1);
      } finally {
        gateA.resolve();
        gateB.resolve();
        enqueueSpy.mockRestore();
        links.restore();
        cancelSpy.mockRestore();
      }
    });

    it('A 가 뒷정리로 작업을 취소하려는 순간 멈춘 사이 표시가 만료돼 B 가 연결까지 끝내도, B 가 연결한 작업은 취소되지 않는다', async () => {
      const note = await stuckNote('cleanup');
      const aInCancel = defer();
      const gateCancel = defer();
      const links = hookLinks(); // A 의 연결만 실패시킨다
      // A 의 첫 취소 호출(연결 여부를 확인한 뒤, 취소 직전)에서 멈춘다
      const cancel = AiJobsService.prototype.cancel;
      let cancelCalls = 0;
      const cancelSpy = vi
        .spyOn(AiJobsService.prototype, 'cancel')
        .mockImplementation(async function (
          this: AiJobsService,
          ...args: Parameters<typeof cancel>
        ) {
          cancelCalls += 1;
          if (cancelCalls === 1) {
            aInCancel.resolve();
            await gateCancel.promise;
          }
          return cancel.apply(this, args);
        });

      try {
        const a = service.register(me.toHexString(), dto(), 'cleanup').then(
          () => null,
          (e: Error) => e,
        );
        await aInCancel.promise;
        const jobA = (await jobs.findOne({ targetId: note._id }).lean())!;
        await expireClaim(note._id);
        // B 가 표시를 잡아 연결까지 끝낸다
        const done = await service.register(me.toHexString(), dto(), 'cleanup');
        expect(done.job._id).not.toBe(jobA._id.toString());

        // 이제 A 의 취소가 이어진다
        gateCancel.resolve();
        expect((await a)?.message).toBe('link failed (A)');

        const row = await materials.findById(note._id).lean();
        expect(row?.processing.jobId?.toString()).toBe(done.job._id);
        expect((await jobs.findById(done.job._id).lean())?.status).toBe('queued');
        expect((await jobs.findById(jobA._id).lean())?.status).toBe('canceled');
        expect(await jobs.countDocuments({ targetId: note._id })).toBe(2);
      } finally {
        gateCancel.resolve();
        cancelSpy.mockRestore();
        links.restore();
      }
    });

    it('표시 필드는 응답에 내보내지 않는다', async () => {
      const res = await service.register(me.toHexString(), dto(), 'shape');
      expect(res.material).not.toHaveProperty('jobClaimToken');
      expect(res.material).not.toHaveProperty('jobClaimedAt');
    });
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
  describe('녹음 북마크 추가', () => {
    const audio = `https://a.blob.core.windows.net/c/uploads/audio/${me.toHexString()}/550e8400-e29b-41d4-a716-446655440008.m4a`;
    const rec = async (user = me) =>
      (
        await service.register(
          user.toHexString(),
          dto({
            kind: 'recording',
            source: 'audio_file',
            blobUrls: [audio.replace(me.toHexString(), user.toHexString())],
          }),
        )
      ).material;
    const marks = async (id: string) =>
      (await materials.findById(id).lean())!.bookmarks.map((b) => b.atSec);
    const add = (id: string, at: number, user = me) =>
      service.addBookmark(user.toHexString(), id, at);

    it('추가하면 상세에 시각 순으로 보이고, 같은 값은 무시한다', async () => {
      const { _id } = await rec();
      await add(_id, 30);
      await add(_id, 5.04);
      await add(_id, 30);
      expect(await marks(_id)).toEqual([5.04, 30]);
      const detail = await service.findMine(me.toHexString(), _id);
      expect(detail.bookmarks).toEqual([{ atSec: 5.04 }, { atSec: 30 }]);
    });

    it('12.31 과 12.34 를 차례로 추가하면 둘 다 저장되고 상세에 시각 순으로 보인다(반올림하지 않는다)', async () => {
      const { _id } = await rec();
      await add(_id, 12.34);
      await add(_id, 12.31);
      expect(await marks(_id)).toEqual([12.31, 12.34]);
      const detail = await service.findMine(me.toHexString(), _id);
      expect(detail.bookmarks).toEqual([{ atSec: 12.31 }, { atSec: 12.34 }]);
    });

    it('노트당 BOOKMARK_MAX 개까지. 넘으면 400, 이미 있는 시각은 가득 차도 그대로 통과', async () => {
      const { _id } = await rec();
      await materials.updateOne(
        { _id },
        {
          $set: {
            bookmarks: Array.from({ length: BOOKMARK_MAX - 1 }, (_, i) => ({ atSec: i })),
          },
        },
      );
      await add(_id, 1000); // 200번째
      await expect(add(_id, 2000)).rejects.toMatchObject({
        status: 400,
        response: { code: 'VALIDATION_FAILED' },
      });
      await add(_id, 1000); // 이미 있음
      await add(_id, 3);
      expect(await marks(_id)).toHaveLength(BOOKMARK_MAX);
    });

    it('남의 노트 · 지운 노트 · 녹음이 아닌 노트 · 없는 노트 · 잘못된 id 는 404이고 바뀌지 않는다', async () => {
      const mine = await rec();
      const handwriting = (await service.register(me.toHexString(), dto())).material;
      const deleted = await rec();
      await service.remove(me.toHexString(), deleted._id);
      const cases = [
        () => add(mine._id, 1, other),
        () => add(handwriting._id, 1),
        () => add(deleted._id, 1),
        () => add(new Types.ObjectId().toHexString(), 1),
        () => add('nope', 1),
      ];
      for (const c of cases) await expect(c()).rejects.toMatchObject({ status: 404 });
      expect(await marks(mine._id)).toEqual([]);
      expect(await marks(handwriting._id)).toEqual([]);
      expect(await marks(deleted._id)).toEqual([]);
    });

    it('마지막 한 자리를 서로 다른 시각 10개가 동시에 다투면 하나만 저장되고 나머지는 400, 최종 200개', async () => {
      const { _id } = await rec();
      await materials.updateOne(
        { _id },
        { $set: { bookmarks: Array.from({ length: BOOKMARK_MAX - 1 }, (_, i) => ({ atSec: i })) } },
      );
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => add(_id, 1000 + i)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(9);
      for (const r of rejected)
        expect(r.reason).toMatchObject({ status: 400, response: { code: 'VALIDATION_FAILED' } });
      expect(await marks(_id)).toHaveLength(BOOKMARK_MAX);
    });

    it('같은 시각을 동시에 두 번 보내도 하나만 저장된다', async () => {
      const { _id } = await rec();
      await Promise.all([add(_id, 42.5), add(_id, 42.5), add(_id, 42.5)]);
      expect(await marks(_id)).toEqual([42.5]);
    });

    it('다른 시각을 동시에 여럿 보내면 모두 저장되고 시각 순이다', async () => {
      const { _id } = await rec();
      const ats = Array.from({ length: 30 }, (_, i) => 100 - i * 3);
      await Promise.all(ats.map((at) => add(_id, at)));
      expect(await marks(_id)).toEqual([...ats].sort((a, b) => a - b));
    });
  });

  describe('다시 시도할 때 입력 파일 읽기 주소 새로 만들기', () => {
    const audio = `https://a.blob.core.windows.net/c/uploads/audio/${me.toHexString()}/550e8400-e29b-41d4-a716-446655440008.m4a`;
    const me$ = () => me.toHexString();
    beforeAll(() => service.onModuleInit());

    /** 만료된 주소 · checkpoint 없음인 실패 작업으로 만든다 */
    const expire = async (jobId: string, input: Record<string, unknown>) => {
      await jobs.updateOne(
        { _id: jobId },
        { $set: { status: 'failed', error: 'x', input }, $unset: { checkpoint: '' } },
      );
    };
    const stored = async (jobId: string) => (await jobs.findById(jobId).lean())!;

    it('필기: 주소만 새 읽기 주소로 바뀌고 다른 필드 · 상태는 처리기 규칙대로', async () => {
      const { job } = await service.register(me$(), dto({ blobUrls: [url(1), url(2)] }));
      await expire(job._id, {
        pages: [
          { pageNo: 1, imageUrl: 'https://old/1?sig=EXPIRED' },
          { pageNo: 2, imageUrl: 'https://old/2?sig=EXPIRED' },
        ],
        subject: '수학',
        seeds: [{ topic: 't', terms: [] }],
      });
      blobs.createReadAccess.mockClear();
      expect((await aiJobs.retry(me$(), job._id)).status).toBe('queued');
      const row = await stored(job._id);
      expect(row.status).toBe('queued');
      expect(row.input).toEqual({
        pages: [
          { pageNo: 1, imageUrl: `${url(1)}?sig=SECRET` },
          { pageNo: 2, imageUrl: `${url(2)}?sig=SECRET` },
        ],
        subject: '수학',
        seeds: [{ topic: 't', terms: [] }],
      });
      // 등록 때와 같은 확인(내 업로드 경로 · 있는 파일)으로 만든다
      expect(blobs.createReadAccess).toHaveBeenCalledTimes(2);
      expect(blobs.createReadAccess.mock.calls[0]![2]).toEqual({
        prefix: `uploads/image/${me$()}/`,
      });
    });

    it('녹음: audioUrl만 바뀌고 sizeBytes · slidesUrl은 그대로', async () => {
      const { job } = await service.register(
        me$(),
        dto({ kind: 'recording', source: 'audio_file', blobUrls: [audio] }),
      );
      await expire(job._id, {
        audioUrl: 'https://old/a?sig=EXPIRED',
        sizeBytes: 7,
        slidesUrl: 'https://old/s?sig=KEEP',
      });
      await aiJobs.retry(me$(), job._id);
      expect((await stored(job._id)).input).toEqual({
        audioUrl: `${audio}?sig=SECRET`,
        sizeBytes: 7,
        slidesUrl: 'https://old/s?sig=KEEP',
      });
    });

    it('녹음을 다시 정리하는 입력(sentences)은 저장소를 부르지 않고 그대로', async () => {
      const { job } = await service.register(
        me$(),
        dto({ kind: 'recording', source: 'audio_file', blobUrls: [audio] }),
      );
      const input = { sentences: ['가', '나'], durationMs: 5 };
      await expire(job._id, input);
      blobs.createReadAccess.mockClear();
      await aiJobs.retry(me$(), job._id);
      expect(blobs.createReadAccess).not.toHaveBeenCalled();
      expect((await stored(job._id)).input).toEqual(input);
      expect((await stored(job._id)).status).toBe('queued');
    });

    it('input.pages 개수가 파일 수와 안 맞으면 오류 없이 input 그대로 다시 시도된다', async () => {
      const { job } = await service.register(me$(), dto({ blobUrls: [url(1), url(2)] }));
      const input = { pages: [{ pageNo: 1, imageUrl: 'https://old/1?sig=EXPIRED' }] };
      await expire(job._id, input);
      await aiJobs.retry(me$(), job._id);
      const row = await stored(job._id);
      expect(row.status).toBe('queued');
      expect(row.input).toEqual(input);
    });

    it('노트를 지운 뒤 다시 시도하면 404이고 작업은 그대로', async () => {
      const { material, job } = await service.register(me$(), dto());
      const input = { pages: [{ pageNo: 1, imageUrl: 'https://old/1?sig=EXPIRED' }] };
      await expire(job._id, input);
      await service.remove(me$(), material._id);
      const before = await stored(job._id);
      await expect(aiJobs.retry(me$(), job._id)).rejects.toMatchObject({ status: 404 });
      expect(await stored(job._id)).toEqual(before);
    });

    it('원본 파일이 없으면 400이고 작업은 그대로', async () => {
      const { job } = await service.register(me$(), dto());
      await expire(job._id, { pages: [{ pageNo: 1, imageUrl: 'https://old/1?sig=EXPIRED' }] });
      const before = await stored(job._id);
      blobs.createReadAccess.mockRejectedValueOnce(
        new BadRequestException({ code: 'VALIDATION_FAILED', message: '파일이 없어요' }),
      );
      await expect(aiJobs.retry(me$(), job._id)).rejects.toMatchObject({ status: 400 });
      expect(await stored(job._id)).toEqual(before);
    });
  });

  describe('조회할 때 끝난 작업 반영 (GET /materials/:id)', () => {
    const finish = (jobId: string, result: Record<string, unknown>) =>
      jobs.updateOne({ _id: jobId }, { $set: { status: 'succeeded', progress: 100, result } });
    const noteResult = {
      pages: [{ pageNo: 1, ocrText: '첫 쪽 글' }],
      lineResults: [],
      warnings: [],
      chunks: [
        {
          order: 1,
          title: '미분',
          path: [],
          text: '정의',
          lines: [{ pageNo: 1 }],
          concept: '미분',
          conceptStatus: 'auto',
          embedding: [0.1],
        },
      ],
    };

    beforeEach(() => {
      quizSets.pregenerate.mockReset();
    });

    it('진행 중이면 진행률만 옮기고, 작업이 끝나기 전에는 퀴즈를 만들지 않는다', async () => {
      const { material, job } = await service.register(me.toHexString(), dto());
      await jobs.updateOne({ _id: job._id }, { $set: { status: 'running', progress: 40 } });
      const got = await service.findMine(me.toHexString(), material._id);
      expect(got.processing).toMatchObject({ status: 'processing', progress: 40 });
      expect(got.summary).toBeNull();
      expect(quizSets.pregenerate).not.toHaveBeenCalled();
    });

    it('성공하면 쪽 글 · 소제목 · 키워드를 채워 완료로, 개념 캐시를 비우고 퀴즈 미리 만들기를 한 번만 부른다', async () => {
      const { material, job } = await service.register(me.toHexString(), dto());
      await materials.updateOne({ _id: material._id }, { $set: { concepts: ['옛 개념'] } });
      await finish(job._id, noteResult);

      // 여러 요청이 동시에 조회해도 한 번만 반영된다
      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.findMine(me.toHexString(), material._id)),
      );
      for (const got of results) {
        expect(got.processing).toMatchObject({ status: 'done', progress: 100 });
        expect(got.pages?.[0]?.ocrText).toBe('첫 쪽 글');
        expect(got.summary).toEqual({ sections: [{ heading: '미분', body: '정의' }], points: [] });
        expect(got.keywords).toEqual(['미분']);
      }
      const row = await materials.findById(material._id).lean();
      expect(row?.concepts).toEqual([]);
      expect(JSON.stringify(row)).not.toContain('embedding');
      expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
      expect(quizSets.pregenerate).toHaveBeenCalledWith(me.toHexString(), material._id);
      // 끝난 노트는 다시 조회해도 작업을 읽지 않고 다시 미리 만들지 않는다
      await service.findMine(me.toHexString(), material._id);
      expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
    });

    it('퀴즈 미리 만들기가 실패해도 노트 조회는 성공한다', async () => {
      const { material, job } = await service.register(me.toHexString(), dto());
      await finish(job._id, noteResult);
      quizSets.pregenerate.mockRejectedValueOnce(new Error('LLM 한도'));
      const got = await service.findMine(me.toHexString(), material._id);
      expect(got.processing.status).toBe('done');
    });

    it('실패 · 취소는 처리 실패로, 다시 시도해 성공하면 완료로 되살아난다', async () => {
      const { material, job } = await service.register(me.toHexString(), dto());
      await jobs.updateOne({ _id: job._id }, { $set: { status: 'canceled' } });
      expect((await service.findMine(me.toHexString(), material._id)).processing.status).toBe(
        'failed',
      );

      await jobs.updateOne({ _id: job._id }, { $set: { status: 'running', progress: 10 } });
      expect((await service.findMine(me.toHexString(), material._id)).processing).toMatchObject({
        status: 'processing',
        progress: 10,
      });
      await finish(job._id, noteResult);
      expect((await service.findMine(me.toHexString(), material._id)).processing.status).toBe(
        'done',
      );
      expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
    });

    it('작업이 없어졌으면 처리 실패로 본다', async () => {
      const { material, job } = await service.register(me.toHexString(), dto());
      await jobs.deleteOne({ _id: job._id });
      expect((await service.findMine(me.toHexString(), material._id)).processing.status).toBe(
        'failed',
      );
    });

    it('PDF 문서는 결과의 쪽 수만큼 펼치고, 소제목은 핵심 요약(points)이 된다', async () => {
      const pdf = `https://a.blob.core.windows.net/c/uploads/document/${me.toHexString()}/550e8400-e29b-41d4-a716-446655440009.pdf`;
      const { material, job } = await service.register(
        me.toHexString(),
        dto({ kind: 'document', source: 'file', blobUrls: [pdf] }),
      );
      await finish(job._id, {
        pages: [
          { pageNo: 1, ocrText: 'a' },
          { pageNo: 2, ocrText: 'b' },
          { pageNo: 3, ocrText: 'c' },
        ],
        chunks: [
          { order: 1, title: '서론', text: 'a', lines: [] },
          { order: 2, title: '본론', text: 'b', lines: [] },
        ],
      });
      const got = await service.findMine(me.toHexString(), material._id);
      expect(got.pages?.map((p) => [p.pageNo, p.ocrText])).toEqual([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]);
      expect(got.summary?.points).toEqual(['서론', '본론']);
      const row = await materials.findById(material._id).lean();
      expect(row?.pages?.every((p) => p.imageUrl === pdf)).toBe(true);
    });

    it('녹음은 슬라이드를 소제목으로 옮기고 퀴즈 미리 만들기를 부르지 않는다', async () => {
      const audio = `https://a.blob.core.windows.net/c/uploads/audio/${me.toHexString()}/550e8400-e29b-41d4-a716-446655440008.m4a`;
      const { material, job } = await service.register(
        me.toHexString(),
        dto({ kind: 'recording', source: 'audio_file', blobUrls: [audio] }),
      );
      await finish(job._id, {
        durationMs: 200000,
        slides: [{ title: '도입', summary: '시작', startMs: 0, endMs: 10 }],
      });
      const got = await service.findMine(me.toHexString(), material._id);
      expect(got.summary).toEqual({ sections: [{ heading: '도입', body: '시작' }], points: [] });
      expect(got.processing.status).toBe('done');
      expect(quizSets.pregenerate).not.toHaveBeenCalled();
    });

    it('응답의 쪽 이미지는 읽기 SAS 주소이고 DB 에는 SAS 없는 주소만 있다', async () => {
      const { material } = await service.register(me.toHexString(), dto());
      const got = await service.findMine(me.toHexString(), material._id);
      expect(got.pages?.[0]?.imageUrl).toBe(`${url(1)}?sig=SECRET`);
      expect(JSON.stringify(await materials.findById(material._id).lean())).not.toContain('SECRET');
    });

    it('남의 노트 · 지운 노트 · 없는 노트 · 잘못된 id 는 모두 404', async () => {
      const { material } = await service.register(me.toHexString(), dto());
      const ids = [
        [other.toHexString(), material._id],
        [me.toHexString(), new Types.ObjectId().toHexString()],
        [me.toHexString(), 'not-an-id'],
        [me.toHexString(), '../users/me'],
      ] as const;
      for (const [user, id] of ids) {
        await expect(service.findMine(user, id)).rejects.toMatchObject({ status: 404 });
      }
      await materials.updateOne({ _id: material._id }, { $set: { deletedAt: new Date() } });
      await expect(service.findMine(me.toHexString(), material._id)).rejects.toMatchObject({
        status: 404,
      });
    });
  });
  describe('목록 · 수정 · 삭제', () => {
    const complete = (jobId: string) =>
      jobs.updateOne(
        { _id: jobId },
        {
          $set: {
            status: 'succeeded',
            progress: 100,
            result: {
              pages: [{ pageNo: 1, ocrText: '글' }],
              chunks: [{ order: 1, title: '제목', text: '본문', lines: [] }],
            },
          },
        },
      );

    beforeEach(() => {
      quizSets.pregenerate.mockReset();
    });

    it('폴더 안의 지우지 않은 노트만 최근 순으로, 정리 중인 노트도 포함하고 쪽은 담지 않는다', async () => {
      const a = await service.register(me.toHexString(), dto({ title: 'a' }));
      const b = await service.register(me.toHexString(), dto({ title: 'b' }));
      const c = await service.register(me.toHexString(), dto({ title: 'c' }));
      await materials.updateOne({ _id: b.material._id }, { $set: { deletedAt: new Date() } });
      const otherFolder = await folders.create({
        ownerId: me,
        title: '다른 폴더',
        subjectName: '수학',
      });
      await service.register(me.toHexString(), dto({ folderId: otherFolder._id.toHexString() }));

      const list = await service.listInFolder(me.toHexString(), folderId);
      expect(list.map((m) => m.title)).toEqual(['c', 'a']);
      expect(list[0]!._id).toBe(c.material._id);
      expect(list[1]!._id).toBe(a.material._id);
      expect(list.every((m) => m.processing.status === 'queued' && m.pages === undefined)).toBe(
        true,
      );
    });

    it('남의 폴더 · 지운 폴더 · 없는 폴더 · 잘못된 id 는 404', async () => {
      const theirs = await folders.create({ ownerId: other, title: '남의', subjectName: '수학' });
      const gone = await folders.create({
        ownerId: me,
        title: '지운',
        subjectName: '수학',
        deletedAt: new Date(),
      });
      for (const id of [
        theirs._id.toHexString(),
        gone._id.toHexString(),
        new Types.ObjectId().toHexString(),
        'nope',
      ]) {
        await expect(service.listInFolder(me.toHexString(), id)).rejects.toMatchObject({
          status: 404,
        });
      }
    });

    it('정리가 끝난 노트는 목록에서도 완료로 보이고, 한 번에 옮기는 수는 상한(20)까지', async () => {
      const made = [];
      for (let i = 0; i < 22; i++) {
        made.push(await service.register(me.toHexString(), dto({ title: `n${i}` })));
      }
      await Promise.all(made.map((m) => complete(m.job._id)));
      const list = await service.listInFolder(me.toHexString(), folderId);
      expect(list).toHaveLength(22);
      expect(list.filter((m) => m.processing.status === 'done')).toHaveLength(LIST_SYNC_MAX);
      // 가장 최근 20개부터 옮긴다
      expect(list.slice(0, LIST_SYNC_MAX).every((m) => m.processing.status === 'done')).toBe(true);
      expect(quizSets.pregenerate).toHaveBeenCalledTimes(LIST_SYNC_MAX);
      // 다음 조회에서 나머지가 옮겨진다
      const again = await service.listInFolder(me.toHexString(), folderId);
      expect(again.every((m) => m.processing.status === 'done')).toBe(true);
    });

    it('목록은 개수 상한 없이 폴더 안 노트를 모두 최근 순으로 돌려준다(201개 이상도)', async () => {
      const base = {
        ownerId: me,
        folderId: new Types.ObjectId(folderId),
        kind: 'handwriting',
        source: 'camera',
        processing: { status: 'done', progress: 100 },
      };
      await materials.insertMany(
        Array.from({ length: 205 }, (_, i) => ({
          ...base,
          title: `m${i}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        })),
      );
      const list = await service.listInFolder(me.toHexString(), folderId);
      expect(list).toHaveLength(205);
      expect(list[0]!.title).toBe('m204');
      expect(list.at(-1)!.title).toBe('m0');
    });

    describe('목록에서 실패한 노트 다시 확인', () => {
      /** 노트를 하나 만들어 작업을 취소해 "처리 실패"로 반영해 둔다(작업은 나중에 재시도로 성공시킬 수 있다) */
      const failedNote = async (title: string) => {
        const made = await service.register(me.toHexString(), dto({ title }));
        await jobs.updateOne({ _id: made.job._id }, { $set: { status: 'canceled' } });
        const row = await service.findMine(me.toHexString(), made.material._id);
        expect(row.processing.status).toBe('failed');
        return made;
      };

      it('실패로 반영된 노트의 작업이 재시도로 성공하면 목록 조회만으로 완료(done)로 바뀐다', async () => {
        const failed = await failedNote('실패했다 되살아남');
        await complete(failed.job._id);

        const list = await service.listInFolder(me.toHexString(), folderId);

        expect(list.find((m) => m._id === failed.material._id)?.processing.status).toBe('done');
        expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
        // 작업이 아직 실패인 노트는 그대로 실패로 보인다
        const still = await failedNote('계속 실패');
        const again = await service.listInFolder(me.toHexString(), folderId);
        expect(again.find((m) => m._id === still.material._id)?.processing.status).toBe('failed');
      });

      it('확인하는 수 상한(20)은 그대로이고, 진행 중인 노트를 먼저 고른 뒤 남는 자리에 실패 노트를 넣는다', async () => {
        const failed = await failedNote('실패 노트');
        await complete(failed.job._id);
        // 더 최근에 만든 진행 중 노트들
        for (let i = 0; i < LIST_SYNC_MAX; i++) {
          await service.register(me.toHexString(), dto({ title: `진행 ${i}` }));
        }
        const full = await service.listInFolder(me.toHexString(), folderId);
        // 진행 중 20개가 자리를 모두 써서 실패 노트는 이번에는 확인하지 못한다
        expect(full.find((m) => m._id === failed.material._id)?.processing.status).toBe('failed');

        await materials.updateOne(
          { title: '진행 0', ownerId: me },
          { $set: { deletedAt: new Date() } },
        );
        const freed = await service.listInFolder(me.toHexString(), folderId);
        // 자리가 하나 남으니 실패 노트도 확인한다
        expect(freed.find((m) => m._id === failed.material._id)?.processing.status).toBe('done');
      });
    });

    it('실패 노트가 21개 이상이어도 확인한 지 오래된 것부터 돌아가며 확인해, 가장 오래된 노트도 결국 갱신된다', async () => {
      // jobId 가 있는 failed 노트 21개를 DB 에 직접 만든다(i=0 이 가장 오래됨). 확인한 적은 한 번도 없다
      const made: { id: Types.ObjectId; jobId: Types.ObjectId }[] = [];
      for (let i = 0; i < LIST_SYNC_MAX + 1; i++) {
        const noteId = new Types.ObjectId();
        const job = await jobs.create({
          userId: me,
          type: 'handwriting_summary',
          targetType: 'material',
          targetId: noteId,
          input: {},
          status: 'failed',
          error: 'boom',
          progress: 0,
          attempts: 3,
          result: null,
        });
        await materials.collection.insertOne({
          _id: noteId,
          ownerId: me,
          folderId: new Types.ObjectId(folderId),
          kind: 'handwriting',
          source: 'camera',
          title: `실패 ${i}`,
          processing: { status: 'failed', progress: 0, jobId: job._id },
          pages: [{ pageNo: 1, imageUrl: url(1), sizeBytes: 100, ocrText: null, takenAt: null }],
          deletedAt: null,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        });
        made.push({ id: noteId, jobId: job._id as Types.ObjectId });
      }
      const oldest = made[0]!;
      // 가장 오래된 노트의 작업만 나중에 재시도로 성공한다
      await complete(oldest.jobId.toString());
      const statusOf = (list: Awaited<ReturnType<typeof service.listInFolder>>) =>
        list.find((m) => m._id === oldest.id.toHexString())?.processing.status;

      const first = await service.listInFolder(me.toHexString(), folderId);
      expect(first).toHaveLength(LIST_SYNC_MAX + 1);
      // 첫 조회: 최신 20개를 확인하고 가장 오래된 노트는 자리가 없어 아직이다
      expect(statusOf(first)).toBe('failed');
      const checked = await materials
        .find({ _id: { $in: made.map((m) => m.id) }, 'processing.checkedAt': { $type: 'date' } })
        .lean();
      expect(checked).toHaveLength(LIST_SYNC_MAX);
      expect(checked.map((c) => c._id.toString())).not.toContain(oldest.id.toString());

      // 두 번째 조회: 확인한 적 없는 노트가 먼저라서 가장 오래된 노트가 갱신된다
      const second = await service.listInFolder(me.toHexString(), folderId);
      expect(statusOf(second)).toBe('done');
      expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
      // 확인 시각은 앱 응답에 나가지 않는다
      for (const m of second)
        expect(Object.keys(m.processing).sort()).toEqual(['jobId', 'progress', 'status']);
    });

    it('목록이 확인한 노트는 결과가 바뀌지 않았어도 확인 시각을 남기고, 확인하지 않은 노트에는 남기지 않는다', async () => {
      const failed = await service.register(me.toHexString(), dto({ title: '실패' }));
      await jobs.updateOne({ _id: failed.job._id }, { $set: { status: 'canceled' } });
      const waiting = await service.register(me.toHexString(), dto({ title: '정리 중' }));
      const before = new Date();

      await service.listInFolder(me.toHexString(), folderId);

      const rows = await materials
        .find({ _id: { $in: [failed.material._id, waiting.material._id] } })
        .lean();
      for (const r of rows)
        expect(r.processing.checkedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      // 상세 조회(findMine)는 확인 시각을 건드리지 않는다
      const stamp = (await materials
        .findById(waiting.material._id)
        .lean())!.processing.checkedAt!.getTime();
      await service.findMine(me.toHexString(), waiting.material._id);
      expect(
        (await materials.findById(waiting.material._id).lean())!.processing.checkedAt!.getTime(),
      ).toBe(stamp);
    });

    describe('페이지 나누기 (listPage)', () => {
      /** 노트 25개: 같은 createdAt 이 5개씩 겹치도록 해서 _id 로 순서를 가른다(i=24 가 가장 최근) */
      const seed = async (count = 25, status = 'done') => {
        const ids: Types.ObjectId[] = [];
        for (let i = 0; i < count; i++) {
          const _id = new Types.ObjectId();
          ids.push(_id);
          await materials.collection.insertOne({
            _id,
            ownerId: me,
            folderId: new Types.ObjectId(folderId),
            kind: 'handwriting',
            source: 'camera',
            title: `n${i}`,
            processing: { status, progress: 100 },
            pages: [],
            deletedAt: null,
            createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 5))),
            updatedAt: new Date(),
          });
        }
        return ids;
      };

      it('limit 이 없으면 전체 배열을 정렬 순서 그대로 돌려준다 (다음 위치 없음)', async () => {
        await seed();
        const all = await service.listInFolder(me.toHexString(), folderId);
        expect(all).toHaveLength(25);
        const page = await service.listPage(me.toHexString(), folderId, {});
        expect(page.items.map((m) => m._id)).toEqual(all.map((m) => m._id));
        expect(page.next).toBeNull();
      });

      it('limit 과 다음 위치로 이어 받으면 겹치지도 빠지지도 않고 전체 순서와 같다 (같은 시각 노트 포함)', async () => {
        await seed();
        const all = (await service.listInFolder(me.toHexString(), folderId)).map((m) => m._id);
        const seen: string[] = [];
        const sizes: number[] = [];
        let after: ListCursor | undefined;
        for (let guard = 0; guard < 10; guard++) {
          const page = await service.listPage(me.toHexString(), folderId, { limit: 7, after });
          sizes.push(page.items.length);
          seen.push(...page.items.map((m) => m._id));
          if (!page.next) break;
          after = decodeCursor(encodeCursor(page.next)); // 헤더로 오가는 문자열을 거쳐도 같다
        }
        expect(sizes).toEqual([7, 7, 7, 4]);
        expect(seen).toEqual(all);
        expect(new Set(seen).size).toBe(25);
      });

      it('딱 맞는 개수면 다음 위치가 없고, 한 개 모자라면 있다', async () => {
        await seed(10);
        expect((await service.listPage(me.toHexString(), folderId, { limit: 10 })).next).toBeNull();
        expect(
          (await service.listPage(me.toHexString(), folderId, { limit: 9 })).next,
        ).not.toBeNull();
        expect(
          (await service.listPage(me.toHexString(), folderId, { limit: 100 })).items,
        ).toHaveLength(10);
      });

      it('지운 노트 · 남의 노트 · 다른 폴더 노트는 페이지에도 섞이지 않는다', async () => {
        const ids = await seed(6);
        await materials.updateOne({ _id: ids[5] }, { $set: { deletedAt: new Date() } });
        await materials.updateOne({ _id: ids[4] }, { $set: { ownerId: other } });
        const page = await service.listPage(me.toHexString(), folderId, { limit: 10 });
        expect(page.items.map((m) => m.title).sort()).toEqual(['n0', 'n1', 'n2', 'n3']);
      });

      it('확인할 노트는 돌려줄 페이지가 아니라 폴더 전체에서 고른다: 첫 페이지 밖의 정리 중 노트도 반영된다', async () => {
        // 가장 오래된 노트는 정리 중이고 작업이 이미 끝났다. 페이지(최근 3개)에는 들어가지 않는다
        const oldest = await service.register(me.toHexString(), dto({ title: '오래된 노트' }));
        await materials.collection.updateOne(
          { _id: new Types.ObjectId(oldest.material._id) },
          { $set: { createdAt: new Date(0) } },
        ); // createdAt 은 Mongoose 로는 바꿀 수 없다
        await complete(oldest.job._id);
        await seed(5);

        const page = await service.listPage(me.toHexString(), folderId, { limit: 3 });

        expect(page.items.map((m) => m.title)).not.toContain('오래된 노트');
        expect((await materials.findById(oldest.material._id).lean())?.processing.status).toBe(
          'done',
        );
        expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
        // 확인 수 상한(20)도 폴더 전체 기준 그대로다
        expect(LIST_SYNC_MAX).toBe(20);
      });

      it('없는 폴더 · 남의 폴더는 페이지를 요청해도 404', async () => {
        await expect(
          service.listPage(me.toHexString(), new Types.ObjectId().toHexString(), { limit: 5 }),
        ).rejects.toMatchObject({ status: 404 });
      });
    });

    describe('확인 대상 고르기: 상태 구분 없이 마지막 확인 시각 순', () => {
      const listOnce = () => service.listInFolder(me.toHexString(), folderId);
      const statusOf = (list: Awaited<ReturnType<typeof listOnce>>, id: string) =>
        list.find((m) => m._id === id)?.processing.status;

      it('진행 중 노트가 21개여도 가장 오래된 노트의 작업이 끝나면 목록을 두 번 부르는 사이에 반영된다', async () => {
        const made = [];
        for (let i = 0; i < LIST_SYNC_MAX + 1; i++) {
          made.push(await service.register(me.toHexString(), dto({ title: `진행 ${i}` })));
        }
        const oldest = made[0]!;
        await complete(oldest.job._id); // 가장 오래된 노트의 작업만 끝난다

        const first = await listOnce();
        // 첫 조회: 확인한 적 없는 노트 중 최신 20개를 확인하고, 가장 오래된 노트는 자리가 없다
        expect(statusOf(first, oldest.material._id)).not.toBe('done');
        const second = await listOnce();
        // 둘째 조회: 확인한 적 없는 노트가 먼저라 가장 오래된 노트가 확인된다
        expect(statusOf(second, oldest.material._id)).toBe('done');
        expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
      });

      it('진행 중 20개 + 실패 1개여도 실패 노트의 작업이 재시도로 성공하면 목록을 두 번 부르는 사이에 완료로 바뀐다', async () => {
        // 가장 오래된 노트가 실패 상태(작업이 취소돼 실패로 반영됨)다
        const failed = await service.register(me.toHexString(), dto({ title: '실패' }));
        await jobs.updateOne({ _id: failed.job._id }, { $set: { status: 'canceled' } });
        await materials.updateOne(
          { _id: failed.material._id },
          { $set: { 'processing.status': 'failed' } },
        );
        await complete(failed.job._id); // 다시 시도해 성공했다
        for (let i = 0; i < LIST_SYNC_MAX; i++) {
          await service.register(me.toHexString(), dto({ title: `진행 ${i}` }));
        }

        const first = await listOnce();
        expect(statusOf(first, failed.material._id)).toBe('failed'); // 진행 중 20개가 먼저 자리를 썼다
        const second = await listOnce();
        expect(statusOf(second, failed.material._id)).toBe('done');
      });

      it('확인 시각이 없는 노트가 있는 노트보다 먼저 확인된다(오름차순 정렬에서 없는 값이 앞선다)', async () => {
        const ids = [];
        for (let i = 0; i < 3; i++) {
          ids.push(
            (await service.register(me.toHexString(), dto({ title: `정렬 ${i}` }))).material._id,
          );
        }
        // 가장 오래된 노트(정렬 0)만 확인 시각이 있다
        await materials.updateOne(
          { _id: ids[0] },
          { $set: { 'processing.checkedAt': new Date(Date.now() - 60_000) } },
        );
        const rows = await materials
          .find({ folderId: new Types.ObjectId(folderId), 'processing.jobId': { $ne: null } })
          .sort({ 'processing.checkedAt': 1, createdAt: -1, _id: -1 })
          .lean();
        // 확인 시각이 없는 둘이 먼저(최신순), 있는 하나가 마지막
        expect(rows.map((r) => r.title)).toEqual(['정렬 2', '정렬 1', '정렬 0']);
      });
    });

    it('저장: 저장 시각을 한 번 남기고(다시 눌러도 그대로), 응답은 노트 모양', async () => {
      const { material } = await service.register(me.toHexString(), dto());
      const first = await service.update(me.toHexString(), material._id, { saved: true });
      expect(first._id).toBe(material._id);
      expect(first).not.toHaveProperty('savedAt');
      const savedAt = (await materials.findById(material._id).lean())?.savedAt;
      expect(savedAt).toBeInstanceOf(Date);
      await new Promise((r) => setTimeout(r, 20));
      await service.update(me.toHexString(), material._id, { saved: true });
      expect((await materials.findById(material._id).lean())?.savedAt?.getTime()).toBe(
        savedAt!.getTime(),
      );
    });

    it('요약 수정: 소제목 · 본문을 바꾸고 points 는 유지, 개념 캐시는 비운다', async () => {
      const { material, job } = await service.register(
        me.toHexString(),
        dto({ kind: 'document', source: 'file', blobUrls: [docUrl] }),
      );
      await complete(job._id);
      // 정리 결과를 먼저 옮겨 두고, 그 뒤에 퀴즈가 저장한 개념 이름이 있는 상태에서 요약을 고친다
      await service.findMine(me.toHexString(), material._id);
      await materials.updateOne({ _id: material._id }, { $set: { concepts: ['옛 개념'] } });
      const got = await service.update(me.toHexString(), material._id, {
        summary: { sections: [{ heading: '고친 제목', body: '고친 본문' }] },
      });
      expect(got.summary).toEqual({
        sections: [{ heading: '고친 제목', body: '고친 본문' }],
        points: ['제목'],
      });
      const row = await materials.findById(material._id).lean();
      expect(row?.concepts).toEqual([]);
      // 다시 조회해도 고친 요약이 그대로(끝난 노트는 작업 결과로 덮어쓰지 않는다)
      expect(
        (await service.findMine(me.toHexString(), material._id)).summary?.sections[0]?.heading,
      ).toBe('고친 제목');
    });

    it('정리가 끝나기 전의 요약 수정은 409 NOTE_NOT_READY', async () => {
      const { material } = await service.register(me.toHexString(), dto());
      await expect(
        service.update(me.toHexString(), material._id, {
          summary: { sections: [{ heading: 'a', body: 'b' }] },
        }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'NOTE_NOT_READY' } });
    });

    it('saved 와 summary 를 함께 보내거나 둘 다 안 보내면 400', async () => {
      const { material } = await service.register(me.toHexString(), dto());
      const both = { saved: true, summary: { sections: [] } } as never;
      await expect(service.update(me.toHexString(), material._id, both)).rejects.toMatchObject({
        status: 400,
      });
      await expect(service.update(me.toHexString(), material._id, {})).rejects.toMatchObject({
        status: 400,
      });
    });

    it('남의 노트 · 없는 노트의 수정 · 삭제는 404', async () => {
      const { material } = await service.register(me.toHexString(), dto());
      await expect(
        service.update(other.toHexString(), material._id, { saved: true }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(service.remove(other.toHexString(), material._id)).rejects.toMatchObject({
        status: 404,
      });
      await expect(service.remove(me.toHexString(), 'nope')).rejects.toMatchObject({ status: 404 });
      expect((await materials.findById(material._id).lean())?.deletedAt).toBeNull();
    });

    it('삭제: 소프트 삭제라 조회 · 목록에서 사라지고, 진행 중인 작업은 건드리지 않는다. 다시 지우면 404', async () => {
      const { material, job } = await service.register(me.toHexString(), dto());
      await service.remove(me.toHexString(), material._id);
      const row = await materials.findById(material._id).lean();
      expect(row?.deletedAt).toBeInstanceOf(Date);
      expect((await jobs.findById(job._id).lean())?.status).toBe('queued');
      await expect(service.findMine(me.toHexString(), material._id)).rejects.toMatchObject({
        status: 404,
      });
      expect(await service.listInFolder(me.toHexString(), folderId)).toEqual([]);
      await expect(service.remove(me.toHexString(), material._id)).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
