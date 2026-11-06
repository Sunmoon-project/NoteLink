import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { HealthController } from '../src/health/health.controller.js';

describe('GET /api/v1/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // DB 연결 없이 컨트롤러만 검사한다(AppModule은 MongoDB에 연결하므로 CI에서 쓸 수 없음)
    const moduleRef = await Test.createTestingModule({ controllers: [HealthController] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('{ data: { status: "ok" } }를 돌려준다', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' } });
  });
});
