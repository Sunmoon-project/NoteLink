import type { MongooseModuleOptions } from '@nestjs/mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppModuleBuilder } from './support/app-module.js';

// @nestjs/mongoose가 내부에서 쓰는 설정 provider 이름(공개 상수가 아님)
const MONGOOSE_MODULE_OPTIONS = 'MongooseModuleOptions';

describe('AppModule의 MongoDB 설정', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('환경변수 MONGODB_URI를 MongoDB 설정의 uri로 넘긴다', async () => {
    vi.stubEnv('MONGODB_URI', 'mongodb://localhost:27017/notelink-test');
    const moduleRef = await createAppModuleBuilder().compile();

    const options = moduleRef.get<MongooseModuleOptions>(MONGOOSE_MODULE_OPTIONS, {
      strict: false,
    });
    await moduleRef.close();

    expect(options).toEqual({ uri: 'mongodb://localhost:27017/notelink-test' });
  });

  it('MONGODB_URI가 비어 있으면 DB 연결 전에 조립 단계에서 실패한다', async () => {
    // 빈 값으로 두면 로컬 .env 파일의 값이 덮어쓰지 않는다(이미 설정된 환경변수가 우선)
    vi.stubEnv('MONGODB_URI', '');

    await expect(createAppModuleBuilder().compile()).rejects.toThrow('MONGODB_URI');
  });
});
