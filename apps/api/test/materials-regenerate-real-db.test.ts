// 진짜 MongoDB에서 정리 결과 「다시 만들기」(POST /materials/:id/regenerate)를 본다(실기기 피드백 2026-11-20).
// 확인하는 것: 같은 원본 · 같은 입력으로 새 작업을 넣고 노트는 옛 결과를 유지, 새 작업이 성공하면 그때만 결과를 바꿈,
// 실패하면 옛 결과 유지, 다시 만드는 중 요약 수정 409, 남의 노트 404, 정리 중 · 다시 만드는 중 409, 한 사람 하루(서울 자정) 3회, 넘으면 429.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 전용 DB를 만들고 끝나면 지운다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27047/?directConnection=true" npx vitest run test/materials-regenerate-real-db.test.ts
import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import {
  MaterialsService,
  REGENERATE_DAILY_LIMIT,
} from '../src/modules/content/materials/materials.service.js';
import {
  RegenQuota,
  RegenQuotaSchema,
} from '../src/modules/content/materials/regen-quota.schema.js';
import { Folder, FolderSchema } from '../src/modules/content/schemas/folder.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_regen_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 정리 결과 다시 만들기', () => {
  let conn: Connection;
  let materials: Model<Material>;
  let folders: Model<Folder>;
  let jobs: Model<AiJob>;
  let quotas: Model<RegenQuota>;
  let service: MaterialsService;
  const me = new Types.ObjectId();
  const other = new Types.ObjectId();
  let folderId: string;

  const url = (n: number) =>
    `https://a.blob.core.windows.net/c/uploads/image/${me.toHexString()}/550e8400-e29b-41d4-a716-44665544000${n}.jpg`;
  const result = (title: string) => ({
    pages: [{ pageNo: 1, ocrText: `${title} 글` }],
    chunks: [{ order: 1, title, text: `${title} 본문`, lines: [{ pageNo: 1 }] }],
  });
  const finish = (jobId: string, status: string, r: Record<string, unknown> | null = null) =>
    jobs.updateOne({ _id: jobId }, { $set: { status, progress: 100, result: r } });

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    folders = conn.model(Folder.name, FolderSchema) as unknown as Model<Folder>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    quotas = conn.model(RegenQuota.name, RegenQuotaSchema) as unknown as Model<RegenQuota>;
    await Promise.all([
      folders.syncIndexes(),
      materials.syncIndexes(),
      jobs.syncIndexes(),
      quotas.syncIndexes(),
    ]);
    const blobs = {
      createReadAccess: vi.fn((u: string, _ttl: number, verify?: unknown) =>
        Promise.resolve({ readUrl: `${u}?sig=NEW`, ...(verify ? { sizeBytes: 100 } : {}) }),
      ),
    };
    service = new MaterialsService(
      materials as never,
      folders as never,
      new AiJobsService(jobs as never),
      blobs as never,
      { pregenerate: vi.fn() } as never,
      conn,
      quotas as never,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    await Promise.all([
      folders.deleteMany({}),
      materials.deleteMany({}),
      jobs.deleteMany({}),
      quotas.deleteMany({}),
    ]);
    folderId = (
      await folders.create({ ownerId: me, title: '수학', subjectName: '수학' })
    )._id.toHexString();
  });

  /** 정리를 마친 필기 노트(첫 결과 「미분」) */
  const doneNote = async () => {
    const { material, job } = await service.register(me.toHexString(), {
      folderId,
      kind: 'handwriting',
      source: 'camera',
      title: '필기',
      blobUrls: [url(1)],
    });
    await finish(job._id, 'succeeded', result('미분'));
    const synced = await service.findMine(me.toHexString(), material._id);
    expect(synced.processing.status).toBe('done');
    return { id: material._id, firstJob: job._id };
  };
  const headings = async (id: string) =>
    (await service.findMine(me.toHexString(), id)).summary?.sections.map((s) => s.heading);

  it('같은 원본 · 같은 입력으로 새 작업을 넣고, 새 작업이 성공하면 그때 결과를 바꾼다', async () => {
    const { id, firstJob } = await doneNote();
    const { material, job } = await service.regenerate(me.toHexString(), id);
    expect(job._id).not.toBe(firstJob);
    expect(job.status).toBe('queued');
    // 다시 만드는 동안 노트는 옛 결과 그대로
    expect(material.processing).toMatchObject({ status: 'done', jobId: firstJob });
    expect(material.summary?.sections[0]?.heading).toBe('미분');
    const [oldJob, newJob] = await Promise.all([
      jobs.findById(firstJob).lean(),
      jobs.findById(job._id).lean(),
    ]);
    expect(newJob).toMatchObject({ type: oldJob!.type, targetType: 'material' });
    expect(newJob!.targetId.toString()).toBe(id);
    // 입력은 같고, 원본 읽기 주소만 새로 만든다
    expect(newJob!.input).toEqual({
      ...(oldJob!.input as object),
      pages: [{ pageNo: 1, imageUrl: `${url(1)}?sig=NEW` }],
    });
    expect(await headings(id)).toEqual(['미분']);

    await finish(job._id, 'succeeded', result('적분'));
    const after = await service.findMine(me.toHexString(), id);
    expect(after.summary?.sections.map((s) => s.heading)).toEqual(['적분']);
    expect(after.processing).toMatchObject({ status: 'done', jobId: job._id });
    // 다시 만들기가 끝나 또 할 수 있다
    await expect(service.regenerate(me.toHexString(), id)).resolves.toBeTruthy();
  });

  it.each(['failed', 'canceled'])(
    '새 작업이 %s 이면 옛 결과를 그대로 두고 다시 할 수 있다',
    async (status) => {
      const { id, firstJob } = await doneNote();
      const { job } = await service.regenerate(me.toHexString(), id);
      await finish(job._id, status);
      const after = await service.findMine(me.toHexString(), id);
      expect(after.summary?.sections.map((s) => s.heading)).toEqual(['미분']);
      expect(after.processing).toMatchObject({ status: 'done', jobId: firstJob });
      await expect(service.regenerate(me.toHexString(), id)).resolves.toBeTruthy();
    },
  );

  // codex 3차 재리뷰(PR #581): 다시 만드는 중에도 노트는 done 이라 요약을 고칠 수 있었고, 끝나면 새 결과가 고친 글을 덮어썼다
  it('다시 만드는 동안에는 요약을 고칠 수 없고(409), 끝난 뒤 고친 글은 그대로 남는다', async () => {
    const { id } = await doneNote();
    const { job } = await service.regenerate(me.toHexString(), id);
    const edit = { summary: { sections: [{ heading: '내가 고침', body: '고친 본문' }] } };
    const blocked = await service.update(me.toHexString(), id, edit).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(ConflictException);
    expect((blocked as ConflictException).getResponse()).toMatchObject({
      code: 'NOTE_NOT_READY',
      message: '다시 만드는 중이라 요약을 고칠 수 없어요. 끝나면 다시 해 주세요',
    });
    // 노트를 읽은 뒤에 다시 만들기가 자리를 잡은 경우(경합)도 저장 조건에서 막는다
    const row = await materials.findById(id).lean();
    const stale = { ...row!, processing: { ...row!.processing, regenJobId: null } };
    const sync = vi.spyOn(service, 'sync').mockResolvedValueOnce(stale as never);
    await expect(service.update(me.toHexString(), id, edit)).rejects.toBeInstanceOf(
      ConflictException,
    );
    sync.mockRestore();
    expect(await headings(id)).toEqual(['미분']);

    await finish(job._id, 'succeeded', result('적분'));
    expect(await headings(id)).toEqual(['적분']);
    await service.update(me.toHexString(), id, edit);
    expect(await headings(id)).toEqual(['내가 고침']);
    // 다음 조회에서도 고친 글이 덮이지 않는다
    expect(await headings(id)).toEqual(['내가 고침']);
  });

  it('양식(FR-19): 고른 양식을 작업 입력에 싣고, 지금 양식과 같으면 400 · 한도를 쓰지 않는다', async () => {
    const { id } = await doneNote();
    const same = await service.regenerate(me.toHexString(), id, 'points').catch((e: unknown) => e);
    expect((same as { getStatus?: () => number }).getStatus?.()).toBe(400);
    expect(await quotas.countDocuments()).toBe(0);
    const { job } = await service.regenerate(me.toHexString(), id, 'terms');
    expect((await jobs.findById(job._id).lean())!.input).toMatchObject({ format: 'terms' });
    // 성공해 옮기기 전까지 노트의 양식은 그대로
    expect((await service.findMine(me.toHexString(), id)).summaryFormat).toBe('points');
    await finish(job._id, 'succeeded', {
      ...result('적분'),
      summary: { format: 'terms', items: [{ head: '적분', text: '넓이' }], points: ['적분: 넓이'] },
    });
    const after = await service.findMine(me.toHexString(), id);
    expect(after.summaryFormat).toBe('terms');
    expect(after.summary).toMatchObject({ format: 'terms', points: ['적분: 넓이'] });
  });

  it('양식 항목이 0개면 지금 결과를 두고 하루 횟수를 돌려준다 — 하루 2번까지만', async () => {
    const { id } = await doneNote();
    for (let i = 0; i < 3; i += 1) {
      const { job } = await service.regenerate(me.toHexString(), id, 'qa');
      await finish(job._id, 'succeeded', {
        ...result('적분'),
        summary: { format: 'qa', items: [], points: [] },
      });
      const after = await service.findMine(me.toHexString(), id);
      expect(after.summary?.sections[0]?.heading).toBe('미분');
      expect(after.summaryFormat).toBe('points');
    }
    expect(await quotas.findOne({}).lean()).toMatchObject({ count: 1, refunds: 2 });
  });

  it('요약을 고쳐도 양식 항목(items · format)은 남는다', async () => {
    const { id } = await doneNote();
    const { job } = await service.regenerate(me.toHexString(), id, 'qa');
    await finish(job._id, 'succeeded', {
      ...result('적분'),
      summary: {
        format: 'qa',
        items: [{ head: '적분은?', text: '넓이' }],
        points: ['적분은? — 넓이'],
      },
    });
    await service.findMine(me.toHexString(), id);
    const edited = await service.update(me.toHexString(), id, {
      summary: { sections: [{ heading: '고친 제목', body: '고친 본문' }] },
    } as never);
    expect(edited.summary).toMatchObject({
      format: 'qa',
      items: [{ head: '적분은?', text: '넓이' }],
    });
  });

  it('남의 노트 · 없는 노트는 404 이고 한도를 쓰지 않는다', async () => {
    const { id } = await doneNote();
    await expect(service.regenerate(other.toHexString(), id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.regenerate(me.toHexString(), new Types.ObjectId().toHexString()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await quotas.countDocuments()).toBe(0);
    expect(await jobs.countDocuments()).toBe(1);
  });

  it('정리 중인 노트 · 다시 만드는 중인 노트는 409, 동시에 눌러도 작업은 하나', async () => {
    const { material } = await service.register(me.toHexString(), {
      folderId,
      kind: 'handwriting',
      source: 'camera',
      title: '정리 중',
      blobUrls: [url(2)],
    });
    await expect(service.regenerate(me.toHexString(), material._id)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const { id } = await doneNote();
    const before = await jobs.countDocuments();
    const tries = await Promise.allSettled([
      service.regenerate(me.toHexString(), id),
      service.regenerate(me.toHexString(), id),
      service.regenerate(me.toHexString(), id),
    ]);
    expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(1);
    for (const t of tries.filter((x) => x.status === 'rejected'))
      expect((t as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(await jobs.countDocuments()).toBe(before + 1);
    // 거절된 요청은 한도를 쓰지 않는다
    expect((await quotas.findOne().lean())?.count).toBe(1);
  });

  it(`한 사람 하루(서울 날짜) ${REGENERATE_DAILY_LIMIT}회까지, 넘으면 429 와 안내 문구. 다음 날은 다시 된다`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-20T14:30:00Z')); // 서울 11/20 23:30
      const { id } = await doneNote();
      for (let i = 0; i < REGENERATE_DAILY_LIMIT; i++) {
        const { job } = await service.regenerate(me.toHexString(), id);
        await finish(job._id, 'failed');
        await service.findMine(me.toHexString(), id);
      }
      const over = await service.regenerate(me.toHexString(), id).catch((e: unknown) => e);
      expect(over).toBeInstanceOf(HttpException);
      expect((over as HttpException).getStatus()).toBe(429);
      expect((over as HttpException).getResponse()).toMatchObject({
        code: 'RATE_LIMITED',
        message: `오늘은 다시 만들기를 ${REGENERATE_DAILY_LIMIT}번 다 썼어요. 내일 다시 해 주세요`,
      });
      // 거절돼도 노트는 다시 만드는 중이 아니다(다음 날 바로 할 수 있게)
      expect((await materials.findById(id).lean())?.processing.regenJobId ?? null).toBeNull();

      vi.setSystemTime(new Date('2026-11-20T15:00:00Z')); // 서울 11/21 00:00
      await expect(service.regenerate(me.toHexString(), id)).resolves.toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
