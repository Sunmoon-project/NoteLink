import { createHash, randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { SocialLoginAttempt } from '../src/modules/auth/schemas/social-login-attempt.schema.js';
import { APP_REDIRECT_URI } from '../src/modules/auth/social-login/social-login.constants.js';
import { createAppModuleBuilder, stubAppEnv, TEST_ENV } from './support/app-module.js';

// 앱(apps/mobile/src/lib/social-auth.ts)이 만드는 값과 같은 방식으로 만든다
const appState = randomBytes(16).toString('hex');
const codeChallenge = createHash('sha256')
  .update(randomBytes(32).toString('hex'))
  .digest('base64url');

/** 앱이 시스템 브라우저로 여는 주소의 쿼리. PATHS.socialStart(provider) 뒤에 붙는다 */
const VALID_QUERY = {
  redirect: APP_REDIRECT_URI,
  state: appState,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
};

const START = '/api/v1/auth/social/google/start';

interface SavedAttempt {
  provider: string;
  oauthState: string;
  appState: string;
  codeChallenge: string;
  expiresAt: Date;
}

describe('GET /api/v1/auth/social/:provider/start', () => {
  let app: INestApplication;
  const saved: SavedAttempt[] = [];
  const failures = { create: 0 };

  beforeAll(async () => {
    stubAppEnv();
    // social_login_attempts 컬렉션만 메모리로 바꾸고 나머지(설정 · 컨트롤러 · 서비스)는 실제 코드로 돈다
    const attempts = {
      create: (data: SavedAttempt) => {
        if (failures.create > 0) {
          failures.create -= 1;
          return Promise.reject(new Error('DB 쓰기 실패'));
        }
        saved.push(data);
        return Promise.resolve(data);
      },
    };
    const moduleRef = await createAppModuleBuilder()
      .overrideProvider(getModelToken(SocialLoginAttempt.name))
      .useValue(attempts)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    saved.length = 0;
    failures.create = 0;
  });

  describe('정상 요청', () => {
    it('302로 구글 로그인 화면에 보낸다', async () => {
      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      expect(res.status).toBe(302);
      const location = new URL(res.headers['location'] as string);
      expect(location.origin + location.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
    });

    it('구글 주소에 서버 설정(client_id · 리디렉션 주소 · 범위)이 담긴다', async () => {
      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      const params = new URL(res.headers['location'] as string).searchParams;
      expect(params.get('client_id')).toBe(TEST_ENV.GOOGLE_CLIENT_ID);
      expect(params.get('redirect_uri')).toBe(TEST_ENV.GOOGLE_REDIRECT_URI);
      expect(params.get('response_type')).toBe('code');
      expect(params.get('scope')).toBe('openid email profile');
    });

    it('로그인 시도를 저장하고, 구글 주소의 state가 저장한 oauthState와 같다', async () => {
      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      const state = new URL(res.headers['location'] as string).searchParams.get('state');
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ provider: 'google', appState, codeChallenge });
      expect(saved[0]!.oauthState).toBe(state);
    });

    it('앱이 보낸 state · code_challenge를 구글 주소에 싣지 않는다', async () => {
      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      const location = res.headers['location'] as string;
      expect(location).not.toContain(appState);
      expect(location).not.toContain(codeChallenge);
    });

    it('client_secret이 응답 어디에도 나오지 않는다', async () => {
      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      expect(JSON.stringify(res.headers)).not.toContain(TEST_ENV.GOOGLE_CLIENT_SECRET);
      expect(res.text).not.toContain(TEST_ENV.GOOGLE_CLIENT_SECRET);
    });

    it('응답을 캐시하지 않게 한다 (주소에 이번 시도의 state가 있다)', async () => {
      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('요청마다 다른 oauthState로 별도의 시도를 저장한다', async () => {
      const first = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);
      const second = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      expect(saved).toHaveLength(2);
      expect(first.headers['location']).not.toBe(second.headers['location']);
    });
  });

  describe('잘못된 쿼리', () => {
    it.each([
      ['redirect가 허용된 앱 주소가 아님', { redirect: 'https://evil.example/cb' }],
      ['state 형식이 틀림', { state: 'short' }],
      ['code_challenge 형식이 틀림', { code_challenge: 'x'.repeat(10) }],
      ['code_challenge_method가 S256이 아님', { code_challenge_method: 'plain' }],
      ['redirect가 없음', { redirect: undefined }],
      ['state가 없음', { state: undefined }],
    ])(
      '%s이면 400 { code, message } 로 거부하고 아무것도 저장하지 않는다',
      async (_reason, change) => {
        const res = await request(app.getHttpServer())
          .get(START)
          .query({ ...VALID_QUERY, ...change })
          .redirects(0);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
        expect(res.headers['location']).toBeUndefined();
        expect(saved).toHaveLength(0);
      },
    );

    it('같은 쿼리를 여러 번 보내도(배열) 거부한다', async () => {
      const res = await request(app.getHttpServer())
        .get(`${START}?state=${appState}&state=${appState}`)
        .query({ ...VALID_QUERY, state: undefined })
        .redirects(0);

      expect(res.status).toBe(400);
      expect(saved).toHaveLength(0);
    });

    it('쿼리가 전혀 없어도 400이다', async () => {
      const res = await request(app.getHttpServer()).get(START).redirects(0);

      expect(res.status).toBe(400);
      expect(saved).toHaveLength(0);
    });

    it('오류 응답에 보낸 값(state · redirect)을 되돌려 주지 않는다', async () => {
      const state = 'secret-state-value-that-is-bad!!';
      const res = await request(app.getHttpServer())
        .get(START)
        .query({ ...VALID_QUERY, state })
        .redirects(0);

      expect(res.status).toBe(400);
      expect(res.text).not.toContain(state);
    });
  });

  describe('지원하지 않는 로그인 방식', () => {
    it.each(['kakao', 'naver', 'facebook', 'Google', 'GOOGLE'])(
      '%s는 404 { code, message } 이고 아무것도 저장하지 않는다',
      async (provider) => {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/auth/social/${provider}/start`)
          .query(VALID_QUERY)
          .redirects(0);

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        expect(res.headers['location']).toBeUndefined();
        expect(saved).toHaveLength(0);
      },
    );
  });

  describe('서버 오류', () => {
    it('시도를 저장하지 못하면 구글로 보내지 않는다 (500, Location 없음)', async () => {
      failures.create = 1;

      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      expect(res.status).toBe(500);
      expect(res.headers['location']).toBeUndefined();
      expect(saved).toHaveLength(0);
    });

    it('오류가 난 다음 요청은 정상으로 처리된다', async () => {
      failures.create = 1;
      await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      const res = await request(app.getHttpServer()).get(START).query(VALID_QUERY).redirects(0);

      expect(res.status).toBe(302);
    });
  });

  describe('주소와 메서드', () => {
    it('앱 계약(PATHS.socialStart)과 같은 주소에서만 응답한다', async () => {
      const prefixed = await request(app.getHttpServer())
        .get(START)
        .query(VALID_QUERY)
        .redirects(0);
      const withoutPrefix = await request(app.getHttpServer())
        .get('/auth/social/google/start')
        .query(VALID_QUERY)
        .redirects(0);

      expect(prefixed.status).toBe(302);
      expect(withoutPrefix.status).toBe(404);
    });

    it('POST는 받지 않는다 (시작은 브라우저가 여는 GET이다)', async () => {
      const res = await request(app.getHttpServer()).post(START).query(VALID_QUERY).redirects(0);

      expect(res.status).toBe(404);
      expect(saved).toHaveLength(0);
    });
  });
});
