import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { AiJob as SharedAiJob, ERROR_CODES, PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import {
  MAX_CONTEXT,
  MAX_PENDING,
  NoteAskService,
} from '../src/modules/content/note-ask/note-ask.service.js';
import { Material } from '../src/modules/content/schemas/material.schema.js';
import { Recording } from '../src/modules/content/schemas/recording.schema.js';
import { AiJob } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { QuizSet } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;
type Row = Record<string, unknown>;
const same = (a: unknown, b: unknown) => String(a) === String(b);

/** findOne · find(조건).lean()만 쓰는 컬렉션. null 조건은 필드가 없거나 null인 문서에 맞는다 */
function fakeCollection(rows: Row[]) {
  const match = (filter: Row) => (r: Row) =>
    Object.entries(filter).every(([k, v]) => (v === null ? r[k] == null : same(r[k], v)));
  return {
    findOne: (filter: Row) => ({ lean: () => Promise.resolve(rows.find(match(filter)) ?? null) }),
    find: (filter: Row) => ({ lean: () => Promise.resolve(rows.filter(match(filter))) }),
  };
}

describe('아바타에게 노트 묻기 (POST /api/v1/materials/:id/ask)', () => {
  let app: INestApplication;
  const jobs = createFakeJobs();
  const materials: Row[] = [];
  const recordings: Row[] = [];
  const quizSets: Row[] = [];
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
      .overrideProvider(getModelToken(QuizSet.name))
      .useValue(fakeCollection(quizSets))
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
    quizSets.length = 0;
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

  it('이 노트로 만든 퀴즈(문제 · 정답 · 해설)도 학습 자료로 넘기고, 남의 · 지운 · 만드는 중인 퀴즈는 뺀다', async () => {
    const id = note();
    const mid = new Types.ObjectId(id);
    const q = (prompt: string) => ({ prompt, answer: '상호 배제', explanation: '자원을 혼자 씀' });
    quizSets.push(
      {
        materialId: mid,
        ownerId: me,
        status: 'ready',
        deletedAt: null,
        questions: [q('조건 하나는?'), { ...q('객관식'), choices: ['상호 배제', '선점'] }],
      },
      {
        materialId: mid,
        ownerId: other,
        status: 'ready',
        deletedAt: null,
        questions: [q('남의 것')],
      },
      {
        materialId: mid,
        ownerId: me,
        status: 'ready',
        deletedAt: new Date(),
        questions: [q('지움')],
      },
      {
        materialId: mid,
        ownerId: me,
        status: 'generating',
        deletedAt: null,
        questions: [q('만드는 중')],
      },
    );
    await ask(id).expect(202);
    const ctx = (jobs.rows[0]!.input as { context: string }).context;
    expect(ctx).toContain('## 퀴즈\nQ. 조건 하나는?\n정답: 상호 배제\n해설: 자원을 혼자 씀');
    // 객관식 보기는 번호와 함께
    expect(ctx).toContain('Q. 객관식\n1) 상호 배제\n2) 선점\n정답: 상호 배제');
    expect(ctx).not.toMatch(/남의 것|지움|만드는 중/);
    // 정리된 내용 → 퀴즈 → 쪽 글 순서
    expect(ctx.indexOf('## 핵심')).toBeLessThan(ctx.indexOf('## 퀴즈'));
    expect(ctx.indexOf('## 퀴즈')).toBeLessThan(ctx.indexOf('[1쪽]'));
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

  const active = () =>
    jobs.rows.filter(
      (r) => r.type === 'note_ask' && ['queued', 'running'].includes(r.status as string),
    ).length;

  /** 개수 조회를 늦춰 한 요청이 세는 동안 다른 요청이 끼어들게 하고, 그때마다 처리기가 가져갈 수 있는(queued) 수를 적는다 */
  const slowCount = () => {
    const count = jobs.model.countDocuments.bind(jobs.model);
    const claimable: number[] = [];
    const spy = vi.spyOn(jobs.model, 'countDocuments').mockImplementation(((filter: never) => {
      const seen = count(filter);
      claimable.push(jobs.rows.filter((r) => r.status === 'queued').length);
      return new Promise((done) => setTimeout(() => done(seen), 20));
    }) as never);
    return { spy, claimable };
  };
  const rejectedAll429 = (res: PromiseSettledResult<unknown>[]) => {
    for (const r of res.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason.getStatus()).toBe(429);
    return res.filter((r) => r.status === 'fulfilled').length;
  };

  it('질문 세 개가 동시에 와도 기다리는 질문은 두 개를 넘지 않고, 넘친 요청은 처리기가 가져갈 수 없고 남지도 않는다', async () => {
    const id = note();
    const service = app.get(NoteAskService);
    const { spy, claimable } = slowCount();
    const res = await Promise.allSettled(
      [1, 2, 3].map(() => service.ask(me.toHexString(), id, { question: '뭐예요?' })),
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    const accepted = rejectedAll429(res);
    expect(accepted).toBeLessThanOrEqual(MAX_PENDING);
    expect(active()).toBe(accepted);
    // 한도를 세는 동안에도 처리기가 가져갈 수 있는 질문은 한도를 넘은 적이 없다
    expect(Math.max(...claimable)).toBeLessThanOrEqual(MAX_PENDING);
    // 거절한 요청은 문서를 남기지 않는다
    expect(jobs.rows).toHaveLength(accepted);
  });

  it('한도에 닿은 뒤 계속 물어도 429만 돌려주고 저장 문서는 늘지 않는다', async () => {
    const id = note();
    await ask(id).expect(202);
    await ask(id).expect(202);
    for (let i = 0; i < 5; i++) await ask(id).expect(429);
    expect(jobs.rows).toHaveLength(MAX_PENDING);
  });

  it('취소한 질문 셋을 동시에 다시 시도해도 기다리는 질문은 두 개를 넘지 않는다', async () => {
    const id = note();
    const service = app.get(NoteAskService);
    const jobsSvc = app.get(AiJobsService);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++)
      ids.push(((await ask(id).expect(202)).body.data as { _id: string })._id);
    for (const j of ids) await jobsSvc.cancel(me.toHexString(), j);
    ids.push((await service.ask(me.toHexString(), id, { question: '뭐예요?' }))._id);
    await jobsSvc.cancel(me.toHexString(), ids[2]!);
    const { spy, claimable } = slowCount();
    const res = await Promise.allSettled(ids.map((j) => jobsSvc.retry(me.toHexString(), j)));
    spy.mockRestore();
    const accepted = rejectedAll429(res);
    expect(accepted).toBeLessThanOrEqual(MAX_PENDING);
    expect(active()).toBe(accepted);
    expect(Math.max(...claimable)).toBeLessThanOrEqual(MAX_PENDING);
    // 거절한 다시 시도는 취소 상태로 돌아간다
    expect(jobs.rows.filter((r) => r.status === 'canceled')).toHaveLength(3 - accepted);
  });

  it('취소한 질문을 다시 시도해도 기다리는 질문이 두 개면 429이고, 취소 상태 그대로 남는다', async () => {
    const id = note();
    const first = (await ask(id).expect(202)).body.data as { _id: string };
    await ask(id).expect(202);
    await request(app.getHttpServer())
      .post(api(PATHS.aiJobCancel(first._id)))
      .set('Authorization', `Bearer ${token}`)
      .expect((r) => expect(r.status).toBeLessThan(300));
    await ask(id).expect(202);
    const retried = await request(app.getHttpServer())
      .post(api(PATHS.aiJobRetry(first._id)))
      .set('Authorization', `Bearer ${token}`)
      .expect(429);
    expect(retried.body).toMatchObject({ code: ERROR_CODES.RATE_LIMITED });
    expect(active()).toBe(MAX_PENDING);
    expect(jobs.rows.find((r) => String(r._id) === first._id)?.status).toBe('canceled');
  });

  it('기다리는 질문이 한도 아래면 취소한 질문을 다시 시도할 수 있다', async () => {
    const id = note();
    const first = (await ask(id).expect(202)).body.data as { _id: string };
    await request(app.getHttpServer())
      .post(api(PATHS.aiJobCancel(first._id)))
      .set('Authorization', `Bearer ${token}`)
      .expect((r) => expect(r.status).toBeLessThan(300));
    const retried = await request(app.getHttpServer())
      .post(api(PATHS.aiJobRetry(first._id)))
      .set('Authorization', `Bearer ${token}`);
    expect(retried.status).toBeLessThan(300);
    expect(retried.body.data).toMatchObject({ _id: first._id, status: 'queued' });
  });

  it('로그인하지 않으면 401', async () => {
    await request(app.getHttpServer())
      .post(api(PATHS.materialAsk(note())))
      .send({})
      .expect(401);
  });
});
