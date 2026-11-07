import type { MongooseModuleOptions } from '@nestjs/mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_CONFIG } from '../src/modules/auth/social-login/social-login.constants.js';
import { SocialLoginService } from '../src/modules/auth/social-login/social-login.service.js';
import { JWT_CONFIG, TokenService } from '../src/modules/auth/token.service.js';
import { TEST_ENV, createAppModuleBuilder, stubAppEnv } from './support/app-module.js';

// @nestjs/mongoose가 내부에서 쓰는 설정 provider 이름(공개 상수가 아님)
const MONGOOSE_MODULE_OPTIONS = 'MongooseModuleOptions';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AppModule의 MongoDB 설정', () => {
  it('환경변수 MONGODB_URI를 MongoDB 설정의 uri로 넘긴다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const options = moduleRef.get<MongooseModuleOptions>(MONGOOSE_MODULE_OPTIONS, {
      strict: false,
    });
    await moduleRef.close();

    expect(options).toEqual({ uri: TEST_ENV.MONGODB_URI });
  });

  it('MONGODB_URI가 비어 있으면 DB 연결 전에 조립 단계에서 실패한다', async () => {
    // 빈 값으로 두면 로컬 .env 파일의 값이 덮어쓰지 않는다(이미 설정된 환경변수가 우선)
    stubAppEnv({ MONGODB_URI: '' });

    await expect(createAppModuleBuilder().compile()).rejects.toThrow('MONGODB_URI');
  });
});

describe('AppModule의 JWT 설정', () => {
  it('JWT_* 환경변수를 읽어 TokenService가 쓸 설정으로 만든다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const config = moduleRef.get(JWT_CONFIG, { strict: false });
    const tokenService = moduleRef.get(TokenService, { strict: false });
    await moduleRef.close();

    expect(config).toEqual({
      accessSecret: TEST_ENV.JWT_ACCESS_SECRET,
      refreshSecret: TEST_ENV.JWT_REFRESH_SECRET,
      accessTTL: '15m',
      refreshTTL: '14d',
    });
    expect(tokenService).toBeInstanceOf(TokenService);
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_ACCESS_TTL', 'JWT_REFRESH_TTL'])(
    '%s가 비어 있으면 서버 조립 단계에서 실패한다',
    async (key) => {
      stubAppEnv({ [key]: '' });

      await expect(createAppModuleBuilder().compile()).rejects.toThrow(key);
    },
  );
});

describe('AppModule의 구글 로그인 설정', () => {
  it('GOOGLE_* 환경변수를 읽어 SocialLoginService가 쓸 설정으로 만든다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const config = moduleRef.get(GOOGLE_CONFIG, { strict: false });
    const service = moduleRef.get(SocialLoginService, { strict: false });
    await moduleRef.close();

    expect(config).toEqual({
      clientId: TEST_ENV.GOOGLE_CLIENT_ID,
      clientSecret: TEST_ENV.GOOGLE_CLIENT_SECRET,
      redirectUri: TEST_ENV.GOOGLE_REDIRECT_URI,
    });
    expect(service).toBeInstanceOf(SocialLoginService);
  });

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])(
    '%s가 비어 있으면 서버 조립 단계에서 실패한다',
    async (key) => {
      stubAppEnv({ [key]: '' });

      await expect(createAppModuleBuilder().compile()).rejects.toThrow(key);
    },
  );

  it('리디렉션 주소가 구글 콜백 경로가 아니면 서버 조립 단계에서 실패한다', async () => {
    stubAppEnv({ GOOGLE_REDIRECT_URI: 'https://notelink.app/api/v1/auth/social/kakao/callback' });

    await expect(createAppModuleBuilder().compile()).rejects.toThrow('GOOGLE_REDIRECT_URI');
  });
});
