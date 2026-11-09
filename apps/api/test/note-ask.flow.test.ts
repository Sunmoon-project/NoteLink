import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { AiJob as SharedAiJob, ERROR_CODES, PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { MAX_CONTEXT } from '../src/modules/content/note-ask/note-ask.service.js';
import { Material } from '../src/modules/content/schemas/material.schema.js';
import { Recording } from '../src/modules/content/schemas/recording.schema.js';
import { AiJob } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;
type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => String(a) === String(b);

/** findOne(조건).lean()만 쓰는 컬렉션. null 조건은 필드가 없거나 null인 문서에 맞는다 */
function fakeCollection(rows: Row[]) {
  return {
    findOne: (filter: Row) => ({
      lean: () =>
        Promise.resolve(
          rows.find((r) =>
            Object.entries(filter).every(([k, v]) => (v === null ? r[k] == null : same(r[k], v))),
          ) ?? null,
        ),
    }),
  };
}

describe('아바타에게 노트 묻기 (POST /api/v1/materials/:id/ask)', () => {
  let app: INestApplication;
  const jobs = createFakeJobs();
  const materials: Row[] = [];
  const recordings: Row[] = [];
  const me = new Types.ObjectId();
  const other = new Types.ObjectId();
  let token: string;

  beforeAll(async () => {
    stubAppEnv();
    const ref = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(getModelToken(AiJob.name))
      .useValue(jobs.model)
      .overrideProvider(getModelToken(Material.name))
      .useValue(fakeCollection(materials))
      .overrideProvider(getModelToken(Recording.name))
      .useValue(fakeCollection(recordings))
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

  beforeEach(() => {
    jobs.rows.length = 0;
    materials.length = 0;
    recordings.length = 0;
  });

  const note = (over: Row = {}) => {
    const row: Row = {
      _id: new Types.ObjectId(),
      ownerId: me,
      kind: 'document',
      title: '운영체제',
      summary: { sections: [{ heading: '교착 상태', body: '네 조건' }], points: ['상호 배제'] },
      pages: [{ pageNo: 1, ocrText: '필기 글' }],
      deletedAt: null,
      ...over,
    };
    materials.push(row);
    return String(row._id);
  };
  const ask = (id: string, body: unknown = { question: '뭐예요?' }) =>
    request(app.getHttpServer())
      .post(api(PATHS.materialAsk(id)))
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  it('노트 글을 모아 note_ask 작업을 넣고 공용 AiJob 모양으로 돌려준다', async () => {
    const id = note();
    const history = [{ role: 'user', text: '안녕' }];
    const res = await ask(id, { question: ' 조건은요? ', history }).expect(202);
    expect(SharedAiJob.parse(res.body.data)).toMatchObject({ type: 'note_ask', status: 'queued' });
    const row = jobs.rows[0]!;
    expect(row).toMatchObject({ type: 'note_ask', targetType: 'material' });
    expect(String(row.targetId)).toBe(id);
    expect(row.input).toEqual({
      title: '운영체제',
      context: '## 교착 상태\n네 조건\n\n## 핵심\n- 상호 배제\n\n[1쪽]\n필기 글',
      history,
      question: '조건은요?',
    });
  });

  it('녹음 노트는 녹음 원문을 붙이고, 긴 글은 처리기 한도로 자른다', async () => {
    const id = note({ kind: 'recording', summary: null, pages: [] });
    recordings.push({
      materialId: new Types.ObjectId(id),
      transcript: { text: '가'.repeat(20_000) },
    });
    await ask(id).expect(202);
    const ctx = (jobs.rows[0]!.input as { context: string }).context;
    expect(ctx.startsWith('## 녹음 원문\n가')).toBe(true);
    expect(ctx).toHaveLength(MAX_CONTEXT);
  });

  it('남의 노트 · 지운 노트 · 잘못된 id는 없는 노트와 같게 404', async () => {
    for (const id of [note({ ownerId: other }), note({ deletedAt: new Date() }), 'nope']) {
      const res = await ask(id).expect(404);
      expect(res.body.code).toBe(ERROR_CODES.NOT_FOUND);
    }
    expect(jobs.rows).toHaveLength(0);
  });

  it('정리 전이라 글이 없으면 409 NOTE_NOT_READY', async () => {
    const res = await ask(note({ summary: null, pages: [] })).expect(409);
    expect(res.body.code).toBe(ERROR_CODES.NOTE_NOT_READY);
  });

  it('빈 질문 · 너무 긴 질문 · 모르는 역할은 400', async () => {
    const id = note();
    for (const body of [
      { question: '  ' },
      { question: 'a'.repeat(501) },
      { question: 'x', history: [{ role: 'system', text: 'x' }] },
    ])
      expect((await ask(id, body).expect(400)).body.code).toBe(ERROR_CODES.VALIDATION);
  });

  it('답을 기다리는 질문이 두 개면 세 번째는 429', async () => {
    const id = note();
    await ask(id).expect(202);
    await ask(id).expect(202);
    const res = await ask(id).expect(429);
    expect(res.body).toMatchObject({ code: ERROR_CODES.RATE_LIMITED, retryAfterSeconds: 10 });
  });

  it('로그인하지 않으면 401', async () => {
    await request(app.getHttpServer())
      .post(api(PATHS.materialAsk(note())))
      .send({})
      .expect(401);
  });
});
