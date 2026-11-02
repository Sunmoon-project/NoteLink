import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

/**
 * 실제 MongoDB 연결 확인용 통합 테스트.
 * MONGODB_URL이 설정돼 있을 때만 실행하고, 없으면 통째로 스킵합니다.
 * (CI에는 아직 로컬 Mongo가 없으므로 CI에서는 자동으로 건너뜁니다.)
 */
const hasDbUrl = Boolean(process.env.MONGODB_URL);
const describeDb = hasDbUrl ? describe : describe.skip;

describeDb('MongoDB 연결', () => {
  let app: INestApplication;
  let connection: Connection;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    connection = moduleRef.get<Connection>(getConnectionToken());
  }, 15000); // DB 연결 대기 여유 (app.module의 serverSelectionTimeoutMS=5s보다 길게)

  afterAll(async () => {
    await app?.close();
  });

  it('Mongoose readyState가 connected(1)이다', () => {
    // 0: disconnected, 1: connected, 2: connecting, 3: disconnecting
    expect(connection.readyState).toBe(1);
  });

  it('ping 명령에 정상 응답한다', async () => {
    const result = await connection.db?.admin().ping();
    expect(result?.ok).toBe(1);
  });
});
