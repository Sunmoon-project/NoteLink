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
import { MaterialsService } from '../src/modules/content/materials/materials.service.js';
import {
  bulletsOf,
  emptyPlayback,
  playbackFromResult,
} from '../src/modules/content/materials/recording-view.js';
import {
  RECORDING_READ_SAS_MS,
  RecordingService,
} from '../src/modules/content/materials/recording.service.js';
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
      diagram: { kind: 'cause', terms: ['변화율', '접선 기울기'], relations: [[0, 1]] },
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
          diagram: { kind: 'cause', terms: ['변화율', '접선 기울기'], relations: [[0, 1]] },
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
    expect(Recording.safeParse({ ...rec, ...emptyPlayback() }).success).toBe(true);
  });

  it('빈 값은 부를 때마다 새 객체다(응답끼리 배열을 나눠 쓰지 않는다)', () => {
    const a = emptyPlayback();
    a.slides.push({ index: 0, title: 'x', bullets: [], startSec: 0, endSec: 1 });
    expect(emptyPlayback().slides).toEqual([]);
  });

  it('결과가 없거나 모양이 틀리면 빈 값', () => {
    for (const bad of [null, undefined, 'x', [], 3])
      expect(playbackFromResult(bad)).toEqual(emptyPlayback());
    expect(playbackFromResult({ sentences: 'x', slides: {} })).toEqual(emptyPlayback());
  });

  it('구간이 틀리거나 글이 빈 문장 · 구간이 틀리거나 요약이 빈 슬라이드는 빼고(노트 요약과 같게), 남은 슬라이드 번호를 0부터 다시 붙인다', () => {
    const out = playbackFromResult({
      durationMs: -1,
      sentences: [
        { text: '  ', startMs: 0, endMs: 1 },
        { text: '거꾸로', startMs: 5, endMs: 1 },
        { text: '길이 0', startMs: 5, endMs: 5 },
        { text: '음수', startMs: -1, endMs: 1 },
        { text: '글자 시각', startMs: '0', endMs: 1 },
        'x',
        { text: ' 남음 ', startMs: 10, endMs: 20 },
      ],
      slides: [
        { title: '빠짐', summary: 'a', startMs: 9, endMs: 1 },
        { title: '요약 없음', summary: ' ', startMs: 0, endMs: 500 },
        { title: '', summary: '제목 없음.', startMs: 500, endMs: 1000 },
        { title: '길이 0', summary: '안 보임.', startMs: 1000, endMs: 1000 },
        {
          title: '둘째',
          summary: '같은 말. 같은 말.',
          startMs: 1000,
          endMs: 3000,
          diagram: { kind: 'venn', terms: ['a', 'b'], relations: [] },
        },
        {
          title: '둘째',
          summary: '제목이 겹침.',
          startMs: 3000,
          endMs: 4000,
          diagram: { kind: 'list', terms: ['a', 'b'], relations: [[0, 9]] },
        },
      ],
    });
    expect(out.durationSec).toBe(0);
    expect(out.transcript).toEqual({
      text: '남음',
      segments: [{ startSec: 0.01, endSec: 0.02, text: '남음' }],
    });
    expect(out.slides).toEqual([
      {
        index: 0,
        title: '내용 1',
        bullets: ['제목 없음.'],
        startSec: 0.5,
        endSec: 1,
        diagram: null,
      },
      // 모르는 kind 는 도식만 null, 범위 밖 관계는 그 관계만 뺀다
      { index: 1, title: '둘째', bullets: ['같은 말.'], startSec: 1, endSec: 3, diagram: null },
      {
        index: 2,
        title: '둘째 (2)',
        bullets: ['제목이 겹침.'],
        startSec: 3,
        endSec: 4,
        diagram: { kind: 'list', terms: ['a', 'b'], relations: [] },
      },
    ]);
  });

  it('핵심어가 5개이거나 21자를 넘는 도식은 처리기처럼 도식만 null(슬라이드는 남김)', () => {
    const slide = (terms: string[]) => ({
      title: '제목',
      summary: '요약.',
      startMs: 0,
      endMs: 1000,
      diagram: { kind: 'list', terms, relations: [] },
    });
    for (const terms of [['a', 'b', 'c', 'd', 'e'], ['가'.repeat(21), 'b']]) {
      const { slides } = playbackFromResult({ sentences: [], slides: [slide(terms)] });
      expect(slides).toHaveLength(1);
      expect(slides[0]?.diagram).toBeNull();
    }
  });

  it('문장의 단어 시각(words)을 초로 바꿔 대본 구간에 함께 넘긴다(앱 자막 채움 · 립싱크)', () => {
    const out = playbackFromResult({
      sentences: [
        {
          text: '가 나',
          startMs: 0,
          endMs: 2000,
          words: [
            { text: '가', startMs: 0, endMs: 800 },
            { text: '나', startMs: 900, endMs: 2000 },
          ],
        },
      ],
    });
    expect(out.transcript.segments).toEqual([
      {
        startSec: 0,
        endSec: 2,
        text: '가 나',
        words: [
          { text: '가', startSec: 0, endSec: 0.8 },
          { text: '나', startSec: 0.9, endSec: 2 },
        ],
      },
    ]);
    const rec = { _id: 'm', materialId: 'm', audioUrl: 'x', audioSizeBytes: 1, ...out };
    expect(Recording.safeParse({ ...rec, visemeUrl: null }).success).toBe(true);
  });

  it('구간이 틀리거나 글이 빈 단어는 빼고, 남는 단어가 없거나 words 가 없으면 words 필드를 두지 않는다(옛 결과)', () => {
    const out = playbackFromResult({
      sentences: [
        {
          text: '하나',
          startMs: 0,
          endMs: 1000,
          words: [
            { text: '거꾸로', startMs: 500, endMs: 100 },
            { text: '길이 0', startMs: 500, endMs: 500 },
            { text: ' ', startMs: 0, endMs: 100 },
            'x',
            { text: '남음', startMs: 100, endMs: 900 },
          ],
        },
        {
          text: '둘',
          startMs: 1000,
          endMs: 2000,
          words: [{ text: '틀림', startMs: -1, endMs: 5 }],
        },
        { text: '셋', startMs: 2000, endMs: 3000, words: 'x' },
        { text: '넷', startMs: 3000, endMs: 4000 },
      ],
    });
    expect(out.transcript.segments).toEqual([
      {
        startSec: 0,
        endSec: 1,
        text: '하나',
        words: [{ text: '남음', startSec: 0.1, endSec: 0.9 }],
      },
      { startSec: 1, endSec: 2, text: '둘' },
      { startSec: 2, endSec: 3, text: '셋' },
      { startSec: 3, endSec: 4, text: '넷' },
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
    service = new RecordingService(materials as never, jobs as never, notes, blobs as never);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    await Promise.all([materials.deleteMany({}), jobs.deleteMany({})]);
    blobs.createReadAccess.mockReset();
    blobs.createReadAccess.mockImplementation((u: string) =>
      Promise.resolve({ readUrl: `${u}?sig=READ` }),
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
          input: { audioUrl: 'x?sig=AI', sizeBytes: 4321 },
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

  it('정리가 끝났으면 읽기 주소 · 등록 때 확인한 크기 · 대본 · 슬라이드를 담고, 노트도 완료로 옮긴다', async () => {
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
    expect(rec.slides[0]).toMatchObject({
      index: 0,
      title: '미분 소개',
      diagram: { kind: 'cause', terms: ['변화율', '접선 기울기'], relations: [[0, 1]] },
    });
    expect(JSON.stringify(rec)).not.toContain('embedding');
    expect(JSON.stringify(rec)).not.toContain('sig=AI');
    // 저장소 확인(HEAD) 없이 서명만, 긴 강의도 끊기지 않게 6시간
    expect(blobs.createReadAccess).toHaveBeenCalledWith(audio(), RECORDING_READ_SAS_MS);
    expect(RECORDING_READ_SAS_MS).toBe(6 * 60 * 60 * 1000);
    const row = await materials.findById(id).lean();
    expect(row?.processing.status).toBe('done');
    expect(row?.summary?.sections[0]?.heading).toBe('미분 소개');
    // 녹음도 정리가 끝나면 첫 퀴즈를 미리 만든다(노트 조회와 같음, FR-38)
    expect(quizSets.pregenerate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['대기 중', { status: 'queued' }],
    ['처리 중', { status: 'running' }],
    ['실패', { status: 'failed' }],
  ])('%s이면 원본만 재생(빈 대본 · 슬라이드)', async (_name, job) => {
    const id = await seed({ job });
    const rec = await service.findMine(me.toHexString(), id);
    expect(rec).toMatchObject({ audioUrl: `${audio()}?sig=READ`, ...emptyPlayback() });
  });

  it('작업이 없어도(연결 전 · 지워짐) 원본은 재생한다', async () => {
    const id = await seed({ job: null });
    const rec = await service.findMine(me.toHexString(), id);
    expect(rec).toMatchObject({
      audioUrl: `${audio()}?sig=READ`,
      audioSizeBytes: 0,
      ...emptyPlayback(),
    });
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

  it('원본 주소가 없거나 · 쓸 수 없거나 · 저장소가 안 되면 빈 주소로 답해 대본 · 슬라이드는 볼 수 있다', async () => {
    const empty = await seed({ blobUrls: [], job: { status: 'succeeded', result: RESULT } });
    expect(await service.findMine(me.toHexString(), empty)).toMatchObject({
      audioUrl: '',
      durationSec: 185.5,
    });
    const id = await seed({ job: { status: 'succeeded', result: RESULT } });
    for (const error of [
      new BadRequestException({ code: 'VALIDATION_FAILED' }),
      new ServiceUnavailableException(),
    ]) {
      blobs.createReadAccess.mockRejectedValueOnce(error);
      const rec = await service.findMine(me.toHexString(), id);
      expect(rec.audioUrl).toBe('');
      expect(rec.slides).toHaveLength(1);
    }
  });

  it('작업의 단어 시각은 대본 구간에 실어 주고, 조각 embedding 은 읽지 않는다', async () => {
    const words = [
      { text: '안녕', startMs: 0, endMs: 600 },
      { text: '하세요.', startMs: 600, endMs: 1500 },
    ];
    const id = await seed({
      job: {
        status: 'succeeded',
        result: { ...RESULT, sentences: [{ ...RESULT.sentences[0], words }] },
      },
    });
    const spy = vi.spyOn(jobs, 'findOne');
    const rec = await service.findMine(me.toHexString(), id);
    expect(rec.transcript.segments[0]?.words).toEqual([
      { text: '안녕', startSec: 0, endSec: 0.6 },
      { text: '하세요.', startSec: 0.6, endSec: 1.5 },
    ]);
    const projections = spy.mock.calls.map((c) => c[1] as Record<string, number> | undefined);
    const mine = projections.find((p) => p && 'result.sentences.text' in p);
    expect(mine).toBeDefined();
    expect(Object.keys(mine!).some((k) => k.includes('chunks'))).toBe(false);
    spy.mockRestore();
  });
});
