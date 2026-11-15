// 녹음 재생 정보(GET /materials/:id/recording). 결과 변환은 항상, 서비스는 MONGODB_VERIFY_URI 가 있을 때
// 진짜 MongoDB(localhost만)로 노트 조회와 같은 sync · 작업 조회를 거쳐 본다. 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/recording.test.ts
import {
  BadRequestException,
  type INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { PATHS, Recording } from '@notelink/shared';
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import {
  APP_READ_SAS_MS,
  MaterialsService,
} from '../src/modules/content/materials/materials.service.js';
import {
  bulletsOf,
  EMPTY_PLAYBACK,
  playbackFromResult,
} from '../src/modules/content/materials/recording-view.js';
import { RecordingService } from '../src/modules/content/materials/recording.service.js';
import { Folder, FolderSchema } from '../src/modules/content/schemas/folder.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

/** 처리기 결과(apps/ai services/recording/models.py RecordingResult) 예 */
const RESULT = {
  durationMs: 185_500,
  transcript: '안녕하세요. 오늘은 미분을 배웁니다.',
  sentences: [
    { text: '안녕하세요.', startMs: 0, endMs: 1500, words: [] },
    { text: '오늘은 미분을 배웁니다.', startMs: 1500, endMs: 4000, words: [] },
  ],
  slides: [
    {
      startMs: 0,
      endMs: 4000,
      sentenceStart: 0,
      sentenceEnd: 2,
      title: '미분 소개',
      summary: '미분은 변화율이다. 접선의 기울기로 본다.',
      diagram: null,
    },
  ],
  chunks: [{ embedding: [0.1] }],
  warnings: [],
};

describe('녹음 정리 결과 → 재생 정보 (playbackFromResult)', () => {
  it('길이는 초로, 문장은 대본 구간으로, 슬라이드는 제목 + 요약 문장 글머리로', () => {
    expect(playbackFromResult(RESULT)).toEqual({
      durationSec: 185.5,
      transcript: {
        text: '안녕하세요. 오늘은 미분을 배웁니다.',
        segments: [
          { startSec: 0, endSec: 1.5, text: '안녕하세요.' },
          { startSec: 1.5, endSec: 4, text: '오늘은 미분을 배웁니다.' },
        ],
      },
      slides: [
        {
          index: 0,
          title: '미분 소개',
          bullets: ['미분은 변화율이다.', '접선의 기울기로 본다.'],
          startSec: 0,
          endSec: 4,
        },
      ],
    });
  });

  it('공용 계약(Recording)의 모양을 지킨다', () => {
    const rec = {
      _id: 'm',
      materialId: 'm',
      audioUrl: 'https://x',
      audioSizeBytes: 1,
      ...playbackFromResult(RESULT),
      visemeUrl: null,
    };
    expect(Recording.safeParse(rec).success).toBe(true);
    expect(Recording.safeParse({ ...rec, ...EMPTY_PLAYBACK }).success).toBe(true);
  });

  it('결과가 없거나 모양이 틀리면 빈 값', () => {
    for (const bad of [null, undefined, 'x', [], 3])
      expect(playbackFromResult(bad)).toEqual(EMPTY_PLAYBACK);
    expect(playbackFromResult({ sentences: 'x', slides: {} })).toEqual(EMPTY_PLAYBACK);
  });

  it('구간이 틀리거나 글이 빈 문장 · 구간이 틀린 슬라이드는 빼고, 남은 슬라이드 번호를 0부터 다시 붙인다', () => {
    const out = playbackFromResult({
      durationMs: -1,
      sentences: [
        { text: '  ', startMs: 0, endMs: 1 },
        { text: '거꾸로', startMs: 5, endMs: 1 },
        { text: '음수', startMs: -1, endMs: 1 },
        { text: '글자 시각', startMs: '0', endMs: 1 },
        'x',
        { text: ' 남음 ', startMs: 10, endMs: 20 },
      ],
      slides: [
        { title: '빠짐', summary: 'a', startMs: 9, endMs: 1 },
        { title: '', summary: '', startMs: 0, endMs: 1000 },
        { title: '둘째', summary: '같은 말. 같은 말.', startMs: 1000, endMs: 3000 },
      ],
    });
    expect(out.durationSec).toBe(0);
    expect(out.transcript).toEqual({
      text: '남음',
      segments: [{ startSec: 0.01, endSec: 0.02, text: '남음' }],
    });
    expect(out.slides).toEqual([
      { index: 0, title: '내용 1', bullets: [], startSec: 0, endSec: 1 },
      { index: 1, title: '둘째', bullets: ['같은 말.'], startSec: 1, endSec: 3 },
    ]);
  });

  it('글머리: 문장 끝(. ! ? 。) 뒤 공백에서 나눈다', () => {
    expect(bulletsOf('첫째다! 둘째인가? 셋째。 넷째')).toEqual([
      '첫째다!',
      '둘째인가?',
      '셋째。',
      '넷째',
    ]);
    expect(bulletsOf('소수 3.14는 원주율이다.')).toEqual(['소수 3.14는 원주율이다.']);
    expect(bulletsOf('')).toEqual([]);
  });
});

describe('녹음 재생 요청 (GET /api/v1/materials/:id/recording)', () => {
  let app: INestApplication;
  let token: string;
  const findMine = vi.fn();
  const me = new Types.ObjectId();

  beforeAll(async () => {
    stubAppEnv();
    const ref = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(RecordingService)
      .useValue({ findMine })
      .compile();
    app = ref.createNestApplication();
    configureApp(app);
    await app.init();
    token = (await ref.get(TokenService).issue(me.toHexString())).accessToken;
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('로그인이 필요하고, { data } 로 재생 정보를 돌려준다', async () => {
    findMine.mockResolvedValue({ _id: 'm1' });
    await request(app.getHttpServer())
      .get(`/api/v1${PATHS.materialRecording('m1')}`)
      .expect(401);
    const res = await request(app.getHttpServer())
      .get(`/api/v1${PATHS.materialRecording('m1')}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ data: { _id: 'm1' } });
    expect(findMine).toHaveBeenCalledWith(me.toHexString(), 'm1');
  });
});

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_recording_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 녹음 재생 정보 (RecordingService)', () => {
  let conn: Connection;
  let materials: Model<Material>;
  let jobs: Model<AiJob>;
  let service: RecordingService;
  const blobs = { createReadAccess: vi.fn() };
  const quizSets = { pregenerate: vi.fn() };
  const me = new Types.ObjectId();
  const other = new Types.ObjectId();
  const folderId = new Types.ObjectId();
  const audio = (user = me) =>
    `https://a.blob.core.windows.net/c/uploads/audio/${user.toHexString()}/550e8400-e29b-41d4-a716-446655440001.m4a`;

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    const folders = conn.model(Folder.name, FolderSchema) as unknown as Model<Folder>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    await Promise.all([materials.syncIndexes(), jobs.syncIndexes()]);
    const aiJobs = new AiJobsService(jobs as never);
    const notes = new MaterialsService(
      materials as never,
      folders as never,
      aiJobs,
      blobs as never,
      quizSets as never,
      conn,
    );
    service = new RecordingService(materials as never, notes, aiJobs, blobs as never);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    await Promise.all([materials.deleteMany({}), jobs.deleteMany({})]);
    blobs.createReadAccess.mockReset();
    blobs.createReadAccess.mockImplementation((u: string) =>
      Promise.resolve({ readUrl: `${u}?sig=READ`, sizeBytes: 4321 }),
    );
    quizSets.pregenerate.mockReset();
  });

  /** 녹음 노트 + 정리 작업 하나 */
  async function seed(
    over: {
      kind?: string;
      owner?: Types.ObjectId;
      status?: string;
      job?: { status: string; result?: unknown } | null;
      blobUrls?: string[];
      deletedAt?: Date;
    } = {},
  ) {
    const owner = over.owner ?? me;
    const materialId = new Types.ObjectId();
    let jobId: Types.ObjectId | null = null;
    if (over.job !== null) {
      const job = over.job ?? { status: 'queued' };
      const [doc] = await jobs.create([
        {
          type: 'recording_summary',
          status: job.status,
          userId: owner,
          targetType: 'material',
          targetId: materialId,
          input: { audioUrl: 'x' },
          result: job.result ?? null,
          progress: job.status === 'succeeded' ? 100 : 0,
        },
      ]);
      jobId = doc!._id;
    }
    await materials.create({
      _id: materialId,
      ownerId: owner,
      folderId,
      kind: over.kind ?? 'recording',
      source: 'live_recording',
      title: '강의',
      processing: { status: over.status ?? 'queued', progress: 0, jobId },
      blobUrls: over.blobUrls ?? [audio(owner)],
      deletedAt: over.deletedAt ?? null,
    });
    return materialId.toHexString();
  }

  it('정리가 끝났으면 읽기 주소 · 실제 크기 · 대본 · 슬라이드를 담고, 노트도 완료로 옮긴다', async () => {
    const id = await seed({ job: { status: 'succeeded', result: RESULT } });
    const rec = await service.findMine(me.toHexString(), id);
    expect(Recording.safeParse(rec).success).toBe(true);
    expect(rec).toMatchObject({
      _id: id,
      materialId: id,
      audioUrl: `${audio()}?sig=READ`,
      audioSizeBytes: 4321,
      durationSec: 185.5,
      visemeUrl: null,
    });
    expect(rec.transcript.segments).toHaveLength(2);
    expect(rec.slides[0]).toMatchObject({ index: 0, title: '미분 소개' });
    expect(JSON.stringify(rec)).not.toContain('embedding');
    expect(blobs.createReadAccess).toHaveBeenCalledWith(audio(), APP_READ_SAS_MS, {
      prefix: `uploads/audio/${me.toHexString()}/`,
    });
    const row = await materials.findById(id).lean();
    expect(row?.processing.status).toBe('done');
    expect(row?.summary?.sections[0]?.heading).toBe('미분 소개');
    // 녹음은 첫 퀴즈를 미리 만들지 않는다(노트 조회와 같음)
    expect(quizSets.pregenerate).not.toHaveBeenCalled();
  });

  it.each([
    ['대기 중', { status: 'queued' }],
    ['처리 중', { status: 'running' }],
    ['실패', { status: 'failed' }],
  ])('%s이면 원본만 재생(빈 대본 · 슬라이드)', async (_name, job) => {
    const id = await seed({ job });
    const rec = await service.findMine(me.toHexString(), id);
    expect(rec).toMatchObject({ audioUrl: `${audio()}?sig=READ`, ...EMPTY_PLAYBACK });
  });

  it('작업이 없어도(연결 전 · 지워짐) 원본은 재생한다', async () => {
    const id = await seed({ job: null });
    const rec = await service.findMine(me.toHexString(), id);
    expect(rec).toMatchObject({ audioSizeBytes: 4321, ...EMPTY_PLAYBACK });
  });

  it('남의 노트 · 지운 노트 · 녹음이 아닌 노트 · 없는 노트 · 잘못된 id 는 404, 저장소를 부르지 않는다', async () => {
    const ids = [
      await seed({ owner: other }),
      await seed({ deletedAt: new Date() }),
      await seed({ kind: 'handwriting' }),
      new Types.ObjectId().toHexString(),
      'nope',
    ];
    for (const id of ids)
      await expect(service.findMine(me.toHexString(), id)).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOT_FOUND' },
      });
    expect(blobs.createReadAccess).not.toHaveBeenCalled();
  });

  it('원본 주소가 없거나 쓸 수 없으면 404, 저장소 장애는 503 그대로', async () => {
    const empty = await seed({ blobUrls: [] });
    await expect(service.findMine(me.toHexString(), empty)).rejects.toMatchObject({ status: 404 });
    const id = await seed();
    blobs.createReadAccess.mockRejectedValueOnce(
      new BadRequestException({ code: 'VALIDATION_FAILED' }),
    );
    await expect(service.findMine(me.toHexString(), id)).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOT_FOUND' },
    });
    blobs.createReadAccess.mockRejectedValueOnce(new ServiceUnavailableException());
    await expect(service.findMine(me.toHexString(), id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
