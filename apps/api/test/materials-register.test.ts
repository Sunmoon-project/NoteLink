import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateMaterialDto } from '../src/modules/content/materials/dto/create-material.dto.js';
import {
  AI_READ_SAS_MS,
  APP_READ_SAS_MS,
  MaterialsService,
  parseIdempotencyKey,
} from '../src/modules/content/materials/materials.service.js';

const me = new Types.ObjectId();
const folderId = new Types.ObjectId();
const base = `https://stnotelinkdev01.blob.core.windows.net/c/uploads`;
const uuid = (n: number) => `550e8400-e29b-41d4-a716-44665544000${n}`;
const url = (kind: 'image' | 'document' | 'audio', n: number, ext: string) =>
  `${base}/${kind}/${me.toHexString()}/${uuid(n)}.${ext}`;

const dto = (over: Partial<CreateMaterialDto> = {}): CreateMaterialDto => ({
  folderId: folderId.toHexString(),
  kind: 'handwriting',
  source: 'camera',
  title: '필기',
  blobUrls: [url('image', 1, 'jpg')],
  ...over,
});

/** 모델 · 작업 · 저장소를 대신하는 가짜. 저장한 노트는 마지막 한 건만 기억한다 */
function setup(over: { folder?: unknown; size?: number } = {}) {
  let saved: Record<string, unknown> | null = null;
  const lean = <T>(v: T) => ({ lean: () => Promise.resolve(v) });
  const materials = {
    findOne: vi.fn(() => lean(saved)),
    create: vi.fn((docs: Record<string, unknown>[]) => {
      saved = { _id: new Types.ObjectId(), createdAt: new Date(), ...docs[0] };
      return Promise.resolve([{ toObject: () => saved }]);
    }),
    updateOne: vi.fn(() => Promise.resolve()),
    // 첫 호출은 "작업 만드는 중" 표시 잡기, 다음은 작업 id 연결
    findOneAndUpdate: vi.fn((_f: unknown, u: { $set: Record<string, unknown> }) => {
      if ('processing.jobId' in u.$set) {
        saved = {
          ...saved!,
          processing: { ...(saved!['processing'] as object), jobId: u.$set['processing.jobId'] },
        };
      }
      return lean(saved);
    }),
  };
  const folderRow = () =>
    over.folder === undefined ? { _id: folderId, subjectName: '수학' } : over.folder;
  const folders = {
    findOne: vi.fn(() => lean(folderRow())),
    findOneAndUpdate: vi.fn(() => lean(folderRow())),
  };
  const jobs = {
    enqueue: vi.fn((j: { type: string; targetId: string }) =>
      Promise.resolve({
        _id: new Types.ObjectId().toString(),
        type: j.type,
        targetId: j.targetId,
        status: 'queued',
      }),
    ),
    cancel: vi.fn(() => Promise.resolve()),
    findMine: vi.fn(),
    findForTarget: vi.fn(() => Promise.resolve(null)),
  };
  const blobs = {
    createReadAccess: vi.fn((u: string, _ttl: number, verify?: { prefix: string }) =>
      Promise.resolve({
        readUrl: `${u}?sig=SECRET`,
        ...(verify ? { sizeBytes: over.size ?? 1000 } : {}),
      }),
    ),
  };
  const quizSets = { pregenerate: vi.fn() };
  const session = { id: 'session' };
  const connection = {
    transaction: vi.fn((work: (s: unknown) => Promise<unknown>) => work(session)),
  };
  const service = new MaterialsService(
    materials as never,
    folders as never,
    jobs as never,
    blobs as never,
    quizSets as never,
    connection as never,
  );
  return { service, materials, folders, jobs, blobs, quizSets, connection, session };
}

const code = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { getResponse?: () => { code?: string } }) => e.getResponse?.().code ?? String(e),
  );

describe('노트 등록 (MaterialsService.register)', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('필기: 쪽을 만들고 노트 정리 작업을 넣는다. 파일 주소는 AI에는 읽기 SAS(24시간), DB에는 SAS 없이', async () => {
    const urls = [url('image', 1, 'jpg'), url('image', 2, 'png')];
    const { material, job } = await t.service.register(me.toHexString(), dto({ blobUrls: urls }));

    expect(t.jobs.enqueue).toHaveBeenCalledWith({
      type: 'handwriting_summary',
      userId: me.toHexString(),
      targetType: 'material',
      targetId: material._id,
      input: {
        pages: [
          { pageNo: 1, imageUrl: `${urls[0]}?sig=SECRET` },
          { pageNo: 2, imageUrl: `${urls[1]}?sig=SECRET` },
        ],
        subject: '수학',
      },
    });
    // 내 폴더 경로(uploads/<업로드 종류>/<내 userId>/)로 검사한다
    expect(t.blobs.createReadAccess).toHaveBeenCalledWith(urls[0], AI_READ_SAS_MS, {
      prefix: `uploads/image/${me.toHexString()}/`,
    });
    const stored = (t.materials.create.mock.calls[0]![0] as unknown[])[0] as {
      pages: { imageUrl: string; sizeBytes: number }[];
      blobUrls: string[];
    };
    expect(stored.pages.map((p) => p.imageUrl)).toEqual(urls);
    expect(stored.pages[0]!.sizeBytes).toBe(1000);
    expect(JSON.stringify(stored)).not.toContain('SECRET');
    // 응답의 쪽 이미지는 읽기 SAS(1시간)
    expect(t.blobs.createReadAccess).toHaveBeenCalledWith(urls[0], APP_READ_SAS_MS);
    expect(material.pages?.[0]?.imageUrl).toBe(`${urls[0]}?sig=SECRET`);
    expect(material.processing).toMatchObject({ status: 'queued', progress: 0, jobId: job._id });
    expect(job.type).toBe('handwriting_summary');
    // 폴더를 맨 앞으로
    expect(t.folders.findOneAndUpdate).toHaveBeenCalled();
  });

  it('SAS를 만들지 못하면 원래 주소를 내보내고 응답은 실패시키지 않는다', async () => {
    const urls = [url('image', 1, 'jpg')];
    t.blobs.createReadAccess.mockImplementation((u: string, _ttl: number, verify?: unknown) =>
      verify
        ? Promise.resolve({ readUrl: `${u}?sig=SECRET`, sizeBytes: 5 })
        : Promise.reject(new Error('설정 없음')),
    );
    const { material } = await t.service.register(me.toHexString(), dto({ blobUrls: urls }));
    expect(material.pages?.[0]?.imageUrl).toBe(urls[0]);
  });

  it('문서: 이미지면 같은 작업 종류(handwriting_summary)로 넣는다. PDF는 단독일 때만', async () => {
    const images = [url('document', 1, 'jpg'), url('document', 2, 'png')];
    await t.service.register(
      me.toHexString(),
      dto({ kind: 'document', source: 'file', blobUrls: images }),
    );
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'handwriting_summary' }),
    );
    expect(t.blobs.createReadAccess).toHaveBeenCalledWith(images[0], AI_READ_SAS_MS, {
      prefix: `uploads/document/${me.toHexString()}/`,
    });

    const pdf = url('document', 3, 'pdf');
    t = setup();
    await expect(
      t.service.register(
        me.toHexString(),
        dto({ kind: 'document', source: 'file', blobUrls: [pdf] }),
      ),
    ).resolves.toBeDefined();

    t = setup();
    expect(
      await code(
        t.service.register(
          me.toHexString(),
          dto({ kind: 'document', source: 'file', blobUrls: [pdf, images[0]!] }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(t.blobs.createReadAccess).not.toHaveBeenCalled();
  });

  it('녹음: 파일 하나만. 녹음 정리 작업에 읽기 주소와 크기를 넣고 쪽은 없다', async () => {
    const audio = url('audio', 1, 'm4a');
    const { material } = await t.service.register(
      me.toHexString(),
      dto({ kind: 'recording', source: 'live_recording', blobUrls: [audio] }),
    );
    expect(t.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'recording_summary',
        input: { audioUrl: `${audio}?sig=SECRET`, sizeBytes: 1000 },
      }),
    );
    expect((t.materials.create.mock.calls[0]![0] as { pages: unknown[] }[])[0]!.pages).toEqual([]);
    expect(material.pages).toBeUndefined();

    t = setup();
    expect(
      await code(
        t.service.register(
          me.toHexString(),
          dto({
            kind: 'recording',
            source: 'audio_file',
            blobUrls: [audio, url('audio', 2, 'mp3')],
          }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('노트 종류에 맞지 않는 파일 · 같은 파일 두 번 · 너무 큰 파일은 400 (작업을 넣지 않는다)', async () => {
    // 필기에 PDF
    expect(
      await code(t.service.register(me.toHexString(), dto({ blobUrls: [url('image', 1, 'pdf')] }))),
    ).toBe('FILE_NOT_ALLOWED');
    // 녹음에 이미지
    expect(
      await code(
        t.service.register(
          me.toHexString(),
          dto({ kind: 'recording', source: 'audio_file', blobUrls: [url('audio', 1, 'jpg')] }),
        ),
      ),
    ).toBe('FILE_NOT_ALLOWED');
    // 중복
    const same = url('image', 1, 'jpg');
    expect(await code(t.service.register(me.toHexString(), dto({ blobUrls: [same, same] })))).toBe(
      'VALIDATION_FAILED',
    );
    // 크기(이미지 20MB 초과)
    t = setup({ size: 21 * 1024 * 1024 });
    expect(await code(t.service.register(me.toHexString(), dto()))).toBe('FILE_NOT_ALLOWED');
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
    expect(t.materials.create).not.toHaveBeenCalled();
  });

  it('저장소가 거절한 파일(남의 경로 · 없는 파일)이면 노트를 만들지 않는다', async () => {
    t.blobs.createReadAccess.mockRejectedValue(
      new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: '사용할 수 없는 파일 주소예요',
      }),
    );
    await expect(t.service.register(me.toHexString(), dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(t.materials.create).not.toHaveBeenCalled();
  });

  it('남의 폴더 · 없는 폴더는 404', async () => {
    t = setup({ folder: null });
    await expect(t.service.register(me.toHexString(), dto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(t.folders.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: me, deletedAt: null }),
    );
  });

  it('폴더 확인 · 폴더 갱신 · 노트 만들기는 한 트랜잭션(같은 세션)이고, 파일 확인 · 작업 등록은 트랜잭션 밖', async () => {
    let inside = false;
    const outside = (name: string) => () => {
      expect(inside, name + ' 은 트랜잭션 밖이어야 해요').toBe(false);
    };
    t.connection.transaction.mockImplementation(async (work: (s: unknown) => Promise<unknown>) => {
      inside = true;
      try {
        return await work(t.session);
      } finally {
        inside = false;
      }
    });
    t.blobs.createReadAccess.mockImplementation((u: string, _ttl: number, verify?: unknown) => {
      outside('저장소 호출')();
      return Promise.resolve({
        readUrl: u + '?sig=SECRET',
        ...(verify ? { sizeBytes: 1000 } : {}),
      });
    });
    const enqueue = t.jobs.enqueue.getMockImplementation()!;
    t.jobs.enqueue.mockImplementation((j: { type: string; targetId: string }) => {
      outside('작업 등록')();
      return enqueue(j);
    });

    await t.service.register(me.toHexString(), dto());

    expect(t.connection.transaction).toHaveBeenCalledTimes(1);
    // 폴더는 { _id, ownerId, deletedAt: null } 조건으로 같은 세션에서 갱신
    expect(t.folders.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: folderId, ownerId: me, deletedAt: null },
      { $set: { updatedAt: expect.any(Date) } },
      expect.objectContaining({ session: t.session }),
    );
    expect(t.materials.create).toHaveBeenCalledWith([expect.any(Object)], { session: t.session });
  });

  it('확인한 뒤 트랜잭션 안에서 폴더가 이미 지워졌으면 404이고 노트 · 작업을 만들지 않는다', async () => {
    t.folders.findOneAndUpdate.mockReturnValue({ lean: () => Promise.resolve(null) });

    await expect(t.service.register(me.toHexString(), dto(), 'key-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(t.materials.create).not.toHaveBeenCalled();
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
  });

  it('키가 없는데 작업을 넣지 못하면 작업 없는 노트가 남지 않게 지운다', async () => {
    t.jobs.enqueue.mockRejectedValue(new Error('db down'));
    await expect(t.service.register(me.toHexString(), dto())).rejects.toThrow('db down');
    expect(t.materials.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'processing.jobId': null }),
      { $set: { deletedAt: expect.any(Date) } },
    );
  });

  it('키가 있으면 같은 키의 재요청이 이어가도록 노트를 남긴다', async () => {
    t.jobs.enqueue.mockRejectedValue(new Error('db down'));
    await expect(t.service.register(me.toHexString(), dto(), 'key-1')).rejects.toThrow('db down');
    // 노트는 지우지 않는다(작업 만드는 중 표시만 푼다)
    expect(t.materials.updateOne).not.toHaveBeenCalledWith(expect.anything(), {
      $set: { deletedAt: expect.any(Date) },
    });
    expect((t.materials.create.mock.calls[0]![0] as unknown[])[0]).toMatchObject({
      requestId: 'key-1',
    });
  });

  it('이 노트에 이미 넣은 작업이 있으면 새로 넣지 않고 그 작업을 연결한다(연결에 져도 취소하지 않는다)', async () => {
    const earlier = {
      _id: new Types.ObjectId().toString(),
      type: 'handwriting_summary',
      status: 'queued',
    };
    t.jobs.findForTarget.mockResolvedValue(earlier as never);

    const res = await t.service.register(me.toHexString(), dto(), 'key-1');

    expect(res.job._id).toBe(earlier._id);
    expect(t.jobs.enqueue).not.toHaveBeenCalled();
    expect(t.jobs.findForTarget).toHaveBeenCalledWith(
      me.toHexString(),
      expect.objectContaining({ type: 'handwriting_summary', targetType: 'material' }),
    );
    expect(t.jobs.cancel).not.toHaveBeenCalled();
  });

  it('같은 키의 둘째 요청은 새로 만들지 않고 처음 결과를, 다른 내용이면 409', async () => {
    const first = await t.service.register(me.toHexString(), dto(), 'key-1');
    t.jobs.findMine.mockResolvedValue(first.job);
    const second = await t.service.register(me.toHexString(), dto(), 'key-1');
    expect(second.material._id).toBe(first.material._id);
    expect(second.job._id).toBe(first.job._id);
    expect(t.materials.create).toHaveBeenCalledTimes(1);
    expect(t.jobs.enqueue).toHaveBeenCalledTimes(1);

    await expect(
      t.service.register(me.toHexString(), dto({ title: '다른 제목' }), 'key-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      await code(t.service.register(me.toHexString(), dto({ title: '다른 제목' }), 'key-1')),
    ).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('읽기 주소 유효 시간', () => {
  it('AI 입력용은 30일(앱의 다시 시도가 입력 주소를 새로 만들지 않는다), 응답용은 1시간', () => {
    expect(AI_READ_SAS_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(APP_READ_SAS_MS).toBe(60 * 60 * 1000);
  });
});

describe('Idempotency-Key 헤더', () => {
  it('없으면 undefined, 있으면 공백 없는 128자 이하만', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey('a'.repeat(128))).toBe('a'.repeat(128));
    for (const bad of ['', 'a'.repeat(129), 'a b', '키', ['a', 'b']]) {
      expect(() => parseIdempotencyKey(bad)).toThrow(BadRequestException);
    }
  });
});
