import { createHash, randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { AuthTokens } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { SocialLoginAttempt } from '../src/modules/auth/schemas/social-login-attempt.schema.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { GoogleOAuthClient } from '../src/modules/auth/social-login/google-oauth.client.js';
import { APP_REDIRECT_URI } from '../src/modules/auth/social-login/social-login.constants.js';
import type { SocialProfile } from '../src/modules/auth/social-login/social-provider.js';
import { createAppModuleBuilder, stubAppEnv, TEST_ENV } from './support/app-module.js';

const START = '/api/v1/auth/social/google/start';
const CALLBACK = '/api/v1/auth/social/google/callback';
const LOGIN = '/api/v1/auth/social/google';

const PROFILE: SocialProfile = {
  providerUid: '110169484474386276334',
  email: 'student@example.com',
  name: '김노트',
};

/** 앱(apps/mobile/src/lib/social-auth.ts)이 하는 것과 같은 방식으로 PKCE 값을 만든다 */
function appSide() {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { state, codeVerifier, challenge };
}

interface Attempt {
  _id: Types.ObjectId;
  provider: string;
  oauthState: string;
  appState: string;
  codeChallenge: string;
  userId: Types.ObjectId | null;
  codeHash: string | null;
  outcome: string | null;
  expiresAt: Date;
}
interface UserRow {
  _id: Types.ObjectId;
  nickname: string;
  email: string | null;
  passwordHash: string | null;
  socialAccounts: { provider: string; providerUid: string }[];
  deletedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  settings: Record<string, unknown>;
  learnerType: string | null;
}
interface TokenRow {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** 가짜 어댑터가 실제 구글 로그인 주소를 만들 수 있도록 서버가 읽는 것과 같은 테스트 환경값으로 설정을 만든다 */
function googleConfig() {
  return {
    clientId: TEST_ENV.GOOGLE_CLIENT_ID!,
    clientSecret: TEST_ENV.GOOGLE_CLIENT_SECRET!,
    redirectUri: TEST_ENV.GOOGLE_REDIRECT_URI!,
  };
}

describe('구글 로그인 전체 흐름: 시작 → 콜백 → 코드 교환 (구글만 가짜, 나머지는 실제 코드)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const attempts: Attempt[] = [];
  const users: UserRow[] = [];
  const refreshTokens: TokenRow[] = [];
  // 구글과 통신하는 fetchProfile만 가짜로 바꾼다. 로그인 주소 만들기(buildAuthUrl)는 실제 구글 어댑터가 그대로 쓰인다
  const google = {
    name: 'google' as const,
    buildAuthUrl: (state: string) => new GoogleOAuthClient(googleConfig()).buildAuthUrl(state),
    fetchProfile: vi.fn<(code: string) => Promise<SocialProfile>>(),
  };

  beforeAll(async () => {
    stubAppEnv();
    const attemptsModel = {
      create: (data: Omit<Attempt, '_id' | 'userId' | 'codeHash' | 'outcome'>) => {
        const row: Attempt = {
          ...data,
          _id: new Types.ObjectId(),
          userId: null,
          codeHash: null,
          outcome: null,
        };
        attempts.push(row);
        return Promise.resolve(row);
      },
      findOneAndUpdate: (
        f: { provider: string; oauthState: string; codeHash: null; expiresAt: { $gt: Date } },
        update: { codeHash: string },
      ) => {
        const row = attempts.find(
          (a) =>
            a.provider === f.provider &&
            a.oauthState === f.oauthState &&
            a.codeHash === null &&
            a.expiresAt > f.expiresAt.$gt,
        );
        if (!row) return Promise.resolve(null);
        const before = { ...row };
        row.codeHash = update.codeHash;
        return Promise.resolve(before);
      },
      updateOne: (f: { _id: Types.ObjectId; codeHash?: string }, update: Partial<Attempt>) => {
        // 실제 Mongoose처럼 조건(_id, 점유한 코드 해시)에 맞는 문서에만 쓰고, 맞은 개수(matchedCount)를 돌려준다
        const row = attempts.find(
          (a) => a._id.equals(f._id) && (!('codeHash' in f) || a.codeHash === f.codeHash),
        );
        if (row) Object.assign(row, update);
        return Promise.resolve({ matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 });
      },
      deleteOne: (f: { _id: Types.ObjectId; codeHash?: string }) => {
        const i = attempts.findIndex(
          (a) => a._id.equals(f._id) && (!('codeHash' in f) || a.codeHash === f.codeHash),
        );
        if (i >= 0) attempts.splice(i, 1);
        return Promise.resolve({});
      },
      findOneAndDelete: (f: { provider: string; codeHash: string; expiresAt: { $gt: Date } }) => {
        const i = attempts.findIndex(
          (a) =>
            a.provider === f.provider && a.codeHash === f.codeHash && a.expiresAt > f.expiresAt.$gt,
        );
        return Promise.resolve(i < 0 ? null : attempts.splice(i, 1)[0]!);
      },
    };
    const usersModel = {
      findOneAndUpdate: (
        f: { socialAccounts: { $elemMatch: { provider: string; providerUid: string } } },
        update: { lastLoginAt: Date },
      ) => {
        const m = f.socialAccounts.$elemMatch;
        const row = users.find(
          (u) =>
            u.deletedAt === null &&
            u.socialAccounts.some(
              (s) => s.provider === m.provider && s.providerUid === m.providerUid,
            ),
        );
        if (!row) return Promise.resolve(null);
        row.lastLoginAt = update.lastLoginAt;
        return Promise.resolve({ _id: row._id });
      },
      exists: (f: { email: string }) => {
        const row = users.find((u) => u.email === f.email && u.deletedAt === null);
        return Promise.resolve(row ? { _id: row._id } : null);
      },
      create: (data: Partial<UserRow>) => {
        const row: UserRow = {
          _id: new Types.ObjectId(),
          nickname: '',
          email: null,
          passwordHash: null,
          socialAccounts: [],
          deletedAt: null,
          lastLoginAt: null,
          createdAt: new Date(),
          settings: {},
          learnerType: null,
          ...data,
        };
        users.push(row);
        return Promise.resolve(row);
      },
      findOne: (f: { _id: Types.ObjectId; deletedAt: null }) =>
        Promise.resolve(
          users.find((u) => u._id.equals(f._id) && u.deletedAt === f.deletedAt) ?? null,
        ),
    };
    const refreshModel = {
      create: (data: Omit<TokenRow, 'revokedAt'>) => {
        const row: TokenRow = { ...data, revokedAt: null };
        refreshTokens.push(row);
        return Promise.resolve({ ...row, _id: new Types.ObjectId() });
      },
    };
    const moduleRef = await createAppModuleBuilder()
      .overrideProvider(getModelToken(SocialLoginAttempt.name))
      .useValue(attemptsModel)
      .overrideProvider(getModelToken(User.name))
      .useValue(usersModel)
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(refreshModel)
      .overrideProvider(GoogleOAuthClient)
      .useValue(google)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    jwt = new JwtService();
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    attempts.length = 0;
    users.length = 0;
    refreshTokens.length = 0;
    google.fetchProfile.mockReset();
    google.fetchProfile.mockResolvedValue(PROFILE);
  });

  /** 앱이 하는 일: 시작 → (구글 로그인) → 콜백이 돌려준 앱 주소에서 code를 꺼낸다 */
  async function loginUntilCode(app_: ReturnType<typeof appSide> = appSide()) {
    const started = await request(app.getHttpServer())
      .get(START)
      .query({
        redirect: APP_REDIRECT_URI,
        state: app_.state,
        code_challenge: app_.challenge,
        code_challenge_method: 'S256',
      })
      .redirects(0);
    const oauthState = new URL(started.headers['location'] as string).searchParams.get('state')!;
    const callback = await request(app.getHttpServer())
      .get(CALLBACK)
      .query({ state: oauthState, code: 'google-code' })
      .redirects(0);
    const [base, search = ''] = (callback.headers['location'] as string).split('?');
    const params = new URLSearchParams(search);
    return {
      app_,
      base,
      state: params.get('state'),
      code: params.get('code'),
      error: params.get('error'),
    };
  }

  const exchange = (token: string | null, codeVerifier: string) =>
    request(app.getHttpServer()).post(LOGIN).send({ token, codeVerifier });

  describe('성공 (새 사용자)', () => {
    it('앱이 하는 순서 그대로 따라가면 토큰과 사용자 정보를 받는다', async () => {
      const step = await loginUntilCode();
      expect(step.base).toBe(APP_REDIRECT_URI);
      expect(step.state).toBe(step.app_.state);

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      expect(res.body.data.user).toMatchObject({
        nickname: '김노트',
        email: 'student@example.com',
      });
    });

    it('응답이 앱의 AuthTokens 검증 스키마(packages/shared)를 통과한다', async () => {
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(AuthTokens.safeParse(res.body.data).success).toBe(true);
    });

    it('응답이 { data } 로 감싸져 있다 (프로젝트 API 규칙)', async () => {
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(Object.keys(res.body)).toEqual(['data']);
    });

    it('access 토큰은 사용자 id를 담고 access 시크릿으로 검증된다', async () => {
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      const payload = await jwt.verifyAsync<{ sub: string }>(res.body.data.accessToken, {
        secret: TEST_ENV.JWT_ACCESS_SECRET,
      });
      expect(payload.sub).toBe(res.body.data.user._id);
    });

    it('refresh 토큰은 DB에 해시로만 저장되고 원문은 저장되지 않는다', async () => {
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(refreshTokens).toHaveLength(1);
      expect(refreshTokens[0]!.tokenHash).toBe(
        createHash('sha256').update(res.body.data.refreshToken).digest('hex'),
      );
      expect(JSON.stringify(refreshTokens)).not.toContain(res.body.data.refreshToken);
    });

    it('비밀번호 해시 · 소셜 연동 정보 · 구글 고유 번호가 응답에 없다', async () => {
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      const text = JSON.stringify(res.body);
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('socialAccounts');
      expect(text).not.toContain(PROFILE.providerUid);
      expect(text).not.toContain(TEST_ENV.GOOGLE_CLIENT_SECRET);
    });

    it('응답을 캐시하지 않게 한다 (토큰이 들어 있다)', async () => {
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('로그인 시도는 끝나면 남지 않는다', async () => {
      const step = await loginUntilCode();
      await exchange(step.code, step.app_.codeVerifier);

      expect(attempts).toHaveLength(0);
    });
  });

  describe('재로그인과 여러 기기', () => {
    it('같은 구글 계정으로 다시 로그인하면 같은 사용자 id를 받는다', async () => {
      const first = await loginUntilCode();
      const a = await exchange(first.code, first.app_.codeVerifier);
      const second = await loginUntilCode();

      const b = await exchange(second.code, second.app_.codeVerifier);

      expect(users).toHaveLength(1);
      expect(b.body.data.user._id).toBe(a.body.data.user._id);
    });

    it('기기마다 다른 refresh 토큰을 받고, 각각 저장된다', async () => {
      const phone = await loginUntilCode();
      const tablet = await loginUntilCode();

      const a = await exchange(phone.code, phone.app_.codeVerifier);
      const b = await exchange(tablet.code, tablet.app_.codeVerifier);

      expect(a.body.data.refreshToken).not.toBe(b.body.data.refreshToken);
      expect(refreshTokens).toHaveLength(2);
    });
  });

  describe('보안', () => {
    it('코드는 한 번만 쓸 수 있다 (같은 코드로 두 번째 교환은 400)', async () => {
      const step = await loginUntilCode();
      await exchange(step.code, step.app_.codeVerifier);

      const again = await exchange(step.code, step.app_.codeVerifier);

      expect(again.status).toBe(400);
      expect(again.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
      expect(refreshTokens).toHaveLength(1);
    });

    it('다른 앱의 codeVerifier로는 교환할 수 없다 (코드를 가로채도 소용없다)', async () => {
      const victim = await loginUntilCode();
      const attacker = appSide();

      const res = await exchange(victim.code, attacker.codeVerifier);

      expect(res.status).toBe(400);
      expect(refreshTokens).toHaveLength(0);
    });

    it('verifier가 틀리면 코드가 소모되어, 그 뒤 올바른 verifier로도 교환할 수 없다', async () => {
      const step = await loginUntilCode();
      await exchange(step.code, appSide().codeVerifier);

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(res.status).toBe(400);
      expect(refreshTokens).toHaveLength(0);
    });

    it('남의 시도에서 나온 코드와 내 verifier를 섞어도 교환되지 않는다', async () => {
      const a = await loginUntilCode();
      const b = await loginUntilCode();

      const res = await exchange(a.code, b.app_.codeVerifier);

      expect(res.status).toBe(400);
    });

    it('만료된 코드는 교환할 수 없다', async () => {
      const step = await loginUntilCode();
      attempts[0]!.expiresAt = new Date(Date.now() - 1000);

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(res.status).toBe(400);
      expect(refreshTokens).toHaveLength(0);
    });

    it('콜백과 교환 사이에 탈퇴한 사용자는 로그인되지 않는다', async () => {
      const step = await loginUntilCode();
      users[0]!.deletedAt = new Date();

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(res.status).toBe(400);
      expect(refreshTokens).toHaveLength(0);
    });

    it('콜백 전의 시도(코드 발급 전)로는 교환할 수 없다', async () => {
      const app_ = appSide();
      await request(app.getHttpServer())
        .get(START)
        .query({
          redirect: APP_REDIRECT_URI,
          state: app_.state,
          code_challenge: app_.challenge,
          code_challenge_method: 'S256',
        })
        .redirects(0);
      const guess = randomBytes(32).toString('base64url');

      const res = await exchange(guess, app_.codeVerifier);

      expect(res.status).toBe(400);
    });

    it('응답에 받은 코드 · verifier를 되돌려 주지 않는다', async () => {
      const step = await loginUntilCode();
      const wrong = appSide().codeVerifier;

      const res = await exchange(step.code, wrong);

      expect(res.text).not.toContain(step.code!);
      expect(res.text).not.toContain(wrong);
    });
  });

  describe('이메일이 겹침', () => {
    const seedAppAccount = () =>
      users.push({
        _id: new Types.ObjectId(),
        nickname: '앱가입자',
        email: 'student@example.com',
        passwordHash: '$2b$10$existing-hash',
        socialAccounts: [],
        deletedAt: null,
        lastLoginAt: null,
        createdAt: new Date(),
        settings: {},
        learnerType: null,
      });

    it('409 { code: ACCOUNT_EXISTS, message } 이고 토큰을 주지 않는다', async () => {
      seedAppAccount();
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        code: 'ACCOUNT_EXISTS',
        message: '이 이메일로 가입한 계정이 있다면 처음 가입한 방법으로 로그인해 주세요',
      });
      expect(refreshTokens).toHaveLength(0);
      expect(JSON.stringify(res.body)).not.toContain('student@example.com');
    });

    it('기존 계정은 바뀌지 않고, 새 계정도 만들어지지 않는다', async () => {
      seedAppAccount();
      const step = await loginUntilCode();

      await exchange(step.code, step.app_.codeVerifier);

      expect(users).toHaveLength(1);
      expect(users[0]!.socialAccounts).toEqual([]);
      expect(users[0]!.lastLoginAt).toBeNull();
    });

    it('앱은 e.message를 토스트로 보여 주므로, 안내 문구가 message에 그대로 들어 있다', async () => {
      seedAppAccount();
      const step = await loginUntilCode();

      const res = await exchange(step.code, step.app_.codeVerifier);

      expect(res.body.message).toBe(
        '이 이메일로 가입한 계정이 있다면 처음 가입한 방법으로 로그인해 주세요',
      );
    });
  });

  describe('잘못된 요청', () => {
    it.each([
      ['본문이 없음', undefined],
      ['token이 없음', { codeVerifier: 'a'.repeat(64) }],
      ['codeVerifier가 없음', { token: 'a'.repeat(43) }],
      ['token 형식이 틀림', { token: 'short', codeVerifier: 'a'.repeat(64) }],
      ['codeVerifier 형식이 틀림', { token: 'a'.repeat(43), codeVerifier: 'short' }],
    ])('%s이면 400 { code, message } 이다', async (_reason, body) => {
      const res = await request(app.getHttpServer()).post(LOGIN).send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
    });

    it.each(['kakao', 'naver', 'facebook', 'Google'])(
      '%s는 404 NOT_FOUND 이다',
      async (provider) => {
        const res = await request(app.getHttpServer())
          .post(`/api/v1/auth/social/${provider}`)
          .send({ token: 'a'.repeat(43), codeVerifier: 'a'.repeat(64) });

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
      },
    );
  });

  describe('주소와 메서드', () => {
    it('앱 계약(PATHS.socialLogin)과 같은 주소에서만 응답한다', async () => {
      const step = await loginUntilCode();

      const res = await request(app.getHttpServer())
        .post('/auth/social/google')
        .send({ token: step.code, codeVerifier: step.app_.codeVerifier });

      expect(res.status).toBe(404);
    });

    it('GET은 받지 않는다 (코드를 주소에 싣지 않는다)', async () => {
      const step = await loginUntilCode();

      const res = await request(app.getHttpServer()).get(`${LOGIN}?token=${step.code}`);

      expect(res.status).toBe(404);
    });

    it('콜백 주소와 겹치지 않는다 (POST /google 와 GET /google/callback)', async () => {
      const step = await loginUntilCode();

      expect(step.code).toBeTruthy();
      const res = await exchange(step.code, step.app_.codeVerifier);
      expect(res.status).toBe(200);
    });
  });
});
