import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { vi } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { User } from '../../src/modules/auth/schemas/user.schema.js';

/** 테스트용 정상 환경변수. 값은 전부 가짜이고, 시크릿은 서로 다른 32자 이상이다 */
export const TEST_ENV: Record<string, string> = {
  MONGODB_URI: 'mongodb://localhost:27017/notelink-test',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '14d',
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/social/google/callback',
  KAKAO_REST_API_KEY: 'test-kakao-rest-api-key',
  KAKAO_CLIENT_SECRET: 'test-kakao-client-secret',
  KAKAO_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/social/kakao/callback',
  NAVER_CLIENT_ID: 'test-naver-client-id',
  NAVER_CLIENT_SECRET: 'test-naver-client-secret',
  NAVER_REDIRECT_URI: 'http://localhost:3000/api/v1/auth/social/naver/callback',
};

/** `TEST_ENV`를 환경변수로 넣는다. 일부만 바꾸려면 overrides를 쓴다. 끝나면 `vi.unstubAllEnvs()`로 되돌린다 */
export function stubAppEnv(overrides: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries({ ...TEST_ENV, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

/**
 * 토큰 검사(TokenService)가 읽는 users 대역: 어떤 id든 탈퇴하지 않은 사용자로 본다.
 * 사용자를 직접 다루는 테스트는 `getModelToken(User.name)`을 다시 덮어쓴다(나중 것이 이긴다)
 */
export const ACTIVE_USERS = {
  findOne: () => ({ lean: () => Promise.resolve({ deletedAt: null }) }),
};

/**
 * `AppModule`을 그대로 조립하되, 실제 MongoDB 연결만 가짜로 바꾼다.
 * 설정(`MONGODB_URI` · `JWT_*` · `GOOGLE_*` 읽기 · 검증)은 실제 코드가 그대로 실행되고, DB 없이도(CI 포함) 돌아간다.
 * `MongooseModule.forFeature`가 `connection.model()`로 모델을 만들기 때문에 가짜 연결에도 `models` · `model`을 둔다.
 */
export function createAppModuleBuilder(): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(getConnectionToken())
    .useValue({ close: () => Promise.resolve(), models: {}, model: () => ({}) })
    .overrideProvider(getModelToken(User.name))
    .useValue(ACTIVE_USERS);
}
