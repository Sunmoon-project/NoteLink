import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { AiJob as SharedAiJob, PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { AiJob } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeJobs, LATER } from './support/fake-ai-jobs.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;

describe('AI 작업 주소 (/api/v1/ai-jobs/:id · cancel · retry)', () => {
  let app: INestApplication;
  let tokens: TokenService;
  let service: AiJobsService;
  const fakeJobs = createFakeJobs();
  const me = new Types.ObjectId().toHexString();
  const other = new Types.ObjectId().toHexString();
  let myToken: string;

  beforeAll(async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(getModelToken(AiJob.name))
      .useValue(fakeJobs.model)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    tokens = moduleRef.get(TokenService);
    service = moduleRef.get(AiJobsService);
    myToken = (await tokens.issue(me)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    fakeJobs.rows.length = 0;
  });

  const http = () => request(app.getHttpServer());
  const add = (userId = me) =>
    service.enqueue({
      type: 'quiz_generate',
      userId,
      targetType: 'quiz_set',
      targetId: new Types.ObjectId().toHexString(),
      input: {},
    });
  const row = (id: string) => fakeJobs.rows.find((r) => r._id.toString() === id)!;

  it('진행 상태를 { data }로 돌려주고, 공용 AiJob 모양이며 input은 보내지 않는다', async () => {
    const job = await add();
    const res = await http()
      .get(api(PATHS.aiJob(job._id)))
      .set('Authorization', `Bearer ${myToken}`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(SharedAiJob.parse(res.body.data)).toEqual(res.body.data);
    expect(res.body.data).toMatchObject({ _id: job._id, status: 'queued' });
    expect(res.body.data).not.toHaveProperty('input');
    expect(res.body.data).not.toHaveProperty('userId');
  });

  it('실패한 작업의 오류는 처리기 문구가 아니라 코드로 보낸다', async () => {
    const job = await add();
    Object.assign(row(job._id), {
      status: 'failed',
      error: 'AI 응답을 받지 못함(http://10.0.0.5)',
    });
    const res = await http()
      .get(api(PATHS.aiJob(job._id)))
      .set('Authorization', `Bearer ${myToken}`)
      .expect(200);
    expect(res.body.data.error).toBe('AI_JOB_FAILED');
  });

  it('처리기가 붙인 앱용 코드(NO_SPEECH 등)는 그대로 보낸다', async () => {
    const job = await add();
    Object.assign(row(job._id), { status: 'failed', error: 'NO_SPEECH: 말소리를 찾지 못함' });
    const res = await http()
      .get(api(PATHS.aiJob(job._id)))
      .set('Authorization', `Bearer ${myToken}`)
      .expect(200);
    expect(res.body.data.error).toBe('NO_SPEECH');
  });

  it.each([
    ['GET', (id: string) => PATHS.aiJob(id)],
    ['POST', (id: string) => PATHS.aiJobCancel(id)],
    ['POST', (id: string) => PATHS.aiJobRetry(id)],
  ])('%s 토큰이 없으면 401 AUTH_TOKEN_EXPIRED', async (method, path) => {
    const job = await add();
    const url = api(path(job._id));
    const res = await (method === 'GET' ? http().get(url) : http().post(url)).expect(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });

  it.each([
    ['남의 작업', () => add(other).then((j) => j._id)],
    ['없는 작업', () => Promise.resolve(new Types.ObjectId().toHexString())],
    ['형식이 틀린 id', () => Promise.resolve('not-an-id')],
  ])('%s는 조회 · 취소 · 다시 시도 모두 404 NOT_FOUND', async (_name, idOf) => {
    const id = await idOf();
    const auth = { Authorization: `Bearer ${myToken}` };
    for (const res of [
      await http()
        .get(api(PATHS.aiJob(id)))
        .set(auth),
      await http()
        .post(api(PATHS.aiJobCancel(id)))
        .set(auth),
      await http()
        .post(api(PATHS.aiJobRetry(id)))
        .set(auth),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('취소는 204이고 다시 시도는 queued 작업을 { data }로 돌려준다(앱 모의 API와 같은 모양)', async () => {
    const job = await add();
    const auth = { Authorization: `Bearer ${myToken}` };
    const canceled = await http()
      .post(api(PATHS.aiJobCancel(job._id)))
      .set(auth)
      .expect(204);
    expect(canceled.text).toBe('');
    expect(row(job._id)['status']).toBe('canceled');
    // 두 번 눌러도 같다
    await http()
      .post(api(PATHS.aiJobCancel(job._id)))
      .set(auth)
      .expect(204);

    const retried = await http()
      .post(api(PATHS.aiJobRetry(job._id)))
      .set(auth)
      .expect(200);
    expect(retried.body.data).toMatchObject({ _id: job._id, status: 'queued', attempts: 0 });
    expect(SharedAiJob.parse(retried.body.data)).toEqual(retried.body.data);
  });

  it.each([
    ['처리기가 아직 잡고 있는 취소 작업', { status: 'canceled', lockedUntil: LATER }],
    ['처리 중', { status: 'running', lockedUntil: LATER }],
    ['이미 성공', { status: 'succeeded' }],
  ])('다시 넣지 않는 경우(%s)는 200으로 지금 상태를 돌려준다', async (_name, state) => {
    const job = await add();
    Object.assign(row(job._id), state);
    const res = await http()
      .post(api(PATHS.aiJobRetry(job._id)))
      .set('Authorization', `Bearer ${myToken}`)
      .expect(200);
    expect(res.body.data).toMatchObject({ _id: job._id, status: state.status });
  });
});
