import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { AiJob as SharedAiJob, PATHS, QuizSet as SharedQuizSet } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { Material } from '../src/modules/content/schemas/material.schema.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { AiJob } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { QuizAttempt } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';
import { createFakeCollection } from './support/fake-collection.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;

describe('퀴즈 세트 주소 (/api/v1/quiz-sets)', () => {
  let app: INestApplication;
  const jobs = createFakeJobs();
  const sets = createFakeCollection();
  const materials = createFakeCollection();
  const me = new Types.ObjectId();
  let auth: { Authorization: string };

  beforeAll(async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(getModelToken(AiJob.name))
      .useValue(jobs.model)
      .overrideProvider(getModelToken(QuizSet.name))
      .useValue(sets.model)
      .overrideProvider(getModelToken(Material.name))
      .useValue(materials.model)
      .overrideProvider(getModelToken(QuizAttempt.name))
      .useValue(createFakeCollection().model)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const { accessToken } = await moduleRef.get(TokenService).issue(me.toHexString());
    auth = { Authorization: `Bearer ${accessToken}` };
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    jobs.rows.length = 0;
    sets.rows.length = 0;
    materials.rows.length = 0;
  });

  const http = () => request(app.getHttpServer());
  const addNote = async () => {
    const created = (await materials.model.create({
      ownerId: me,
      folderId: new Types.ObjectId(),
      title: '세포 생물학',
      deletedAt: null,
      pages: [
        {
          pageNo: 1,
          ocrText:
            '세포막은 세포를 둘러싼다.\n핵에는 DNA가 있다.\n리보솜은 단백질을 만든다.\n미토콘드리아는 에너지를 만든다.\n골지체는 단백질을 포장한다.',
        },
      ],
    } as never)) as unknown as { _id: Types.ObjectId };
    return created._id.toHexString();
  };

  it('만들기 → { data: { quizSet, job } }, 목록 · 하나 조회는 { data }', async () => {
    const materialId = await addNote();
    const res = await http().post(api(PATHS.quizSets)).set(auth).send({ materialId }).expect(201);
    const { quizSet, job } = res.body.data;
    expect(SharedQuizSet.parse(quizSet)).toEqual(quizSet);
    expect(SharedAiJob.parse(job)).toEqual(job);
    expect(job).toMatchObject({ targetType: 'quiz_set', targetId: quizSet._id });
    expect(job).not.toHaveProperty('input');

    const one = await http()
      .get(api(PATHS.quizSet(quizSet._id)))
      .set(auth)
      .expect(200);
    expect(one.headers['cache-control']).toBe('no-store');
    expect(one.body.data).toMatchObject({ _id: quizSet._id, status: 'generating' });
    const list = await http().get(api(PATHS.quizSets)).set(auth).expect(200);
    expect(list.body.data.map((s: { _id: string }) => s._id)).toEqual([quizSet._id]);
  });

  it.each([[{}], [{ materialId: 3 }], [{ materialId: '' }]])(
    '본문 %j는 400 VALIDATION_FAILED',
    async (body) => {
      const res = await http().post(api(PATHS.quizSets)).set(auth).send(body).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    },
  );

  it('없는 노트는 404 NOT_FOUND', async () => {
    const res = await http()
      .post(api(PATHS.quizSets))
      .set(auth)
      .send({ materialId: new Types.ObjectId().toHexString() })
      .expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['POST', PATHS.quizSets],
    ['GET', PATHS.quizSets],
    ['GET', PATHS.quizSet(new Types.ObjectId().toHexString())],
  ])('%s %s는 토큰이 없으면 401 AUTH_TOKEN_EXPIRED', async (method, path) => {
    const url = api(path);
    const res = await (method === 'GET' ? http().get(url) : http().post(url)).expect(401);
    expect(res.body).toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });
});
