import { createHash, randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
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
import { KakaoOAuthClient } from '../src/modules/auth/social-login/kakao-oauth.client.js';
import { APP_REDIRECT_URI } from '../src/modules/auth/social-login/social-login.constants.js';
import {
  type SocialProfile,
  SocialProviderError,
} from '../src/modules/auth/social-login/social-provider.js';
import { createAppModuleBuilder, stubAppEnv, TEST_ENV } from './support/app-module.js';

type Provider = 'google' | 'kakao';

const path = (provider: Provider) => ({
  start: `/api/v1/auth/social/${provider}/start`,
  callback: `/api/v1/auth/social/${provider}/callback`,
  login: `/api/v1/auth/social/${provider}`,
});

const KAKAO_PROFILE: SocialProfile = {
  providerUid: '3912345678',
  email: 'student@example.com',
  name: '카카오노트',
};
const GOOGLE_PROFILE: SocialProfile = {
  providerUid: '110169484474386276334',
  email: 'google-student@example.com',
  name: '구글노트',
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

describe('카카오 로그인 전체 흐름 (구글과 함께 등록된 상태, 제공자 서버 호출만 가짜)', () => {
  let app: INestApplication;
  const attempts: Attempt[] = [];
  const users: UserRow[] = [];
  const refreshTokens: TokenRow[] = [];
  // 제공자와 통신하는 fetchProfile만 가짜로 바꾼다. 로그인 주소 만들기(buildAuthUrl)는 실제 어댑터가 그대로 쓰인다
  const kakao = {
    name: 'kakao' as const,
    buildAuthUrl: (state: string) =>
      new KakaoOAuthClient({
        restApiKey: TEST_ENV.KAKAO_REST_API_KEY!,
        clientSecret: TEST_ENV.KAKAO_CLIENT_SECRET!,
        redirectUri: TEST_ENV.KAKAO_REDIRECT_URI!,
      }).buildAuthUrl(state),
    fetchProfile: vi.fn<(code: string) => Promise<SocialProfile>>(),
  };
  const google = {
    name: 'google' as const,
    buildAuthUrl: (state: string) =>
      new GoogleOAuthClient({
        clientId: TEST_ENV.GOOGLE_CLIENT_ID!,
        clientSecret: TEST_ENV.GOOGLE_CLIENT_SECRET!,
        redirectUri: TEST_ENV.GOOGLE_REDIRECT_URI!,
      }).buildAuthUrl(state),
    fetchProfile: vi.fn<(code: string) => Promise<SocialProfile>>(),
  };

  beforeAll(async () => {
    stubAppEnv();
    const sameAttempt = (a: Attempt, f: { _id: Types.ObjectId; codeHash?: string }) =>
      a._id.equals(f._id) && (!('codeHash' in f) || a.codeHash === f.codeHash);
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
        f: {
          provider?: string;
          oauthState: string;
          codeHash: null;
          expiresAt: { $gt: Date };
        },
        update: { codeHash: string },
      ) => {
        // 실제 Mongo처럼 조건에 있는 항목만 따진다(조건에서 provider를 빼면 어느 제공자의 시도든 찾는다)
        const row = attempts.find(
          (a) =>
            (f.provider === undefined || a.provider === f.provider) &&
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
        const row = attempts.find((a) => sameAttempt(a, f));
        if (row) Object.assign(row, update);
        return Promise.resolve({ matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 });
      },
      deleteOne: (f: { _id: Types.ObjectId; codeHash?: string }) => {
        const i = attempts.findIndex((a) => sameAttempt(a, f));
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
      .overrideProvider(KakaoOAuthClient)
      .useValue(kakao)
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
    attempts.length = 0;
    users.length = 0;
    refreshTokens.length = 0;
    kakao.fetchProfile.mockReset();
    kakao.fetchProfile.mockResolvedValue(KAKAO_PROFILE);
    google.fetchProfile.mockReset();
    google.fetchProfile.mockResolvedValue(GOOGLE_PROFILE);
  });

  /** 앱이 하는 일: 시작 → (제공자 로그인) → 콜백이 돌려준 앱 주소에서 code를 꺼낸다 */
  async function loginUntilCode(provider: Provider, callbackQuery?: Record<string, string>) {
    const app_ = appSide();
    const started = await request(app.getHttpServer())
      .get(path(provider).start)
      .query({
        redirect: APP_REDIRECT_URI,
        state: app_.state,
        code_challenge: app_.challenge,
        code_challenge_method: 'S256',
      })
      .redirects(0);
    const authUrl = new URL(started.headers['location'] as string);
    const oauthState = authUrl.searchParams.get('state')!;
    const callback = await request(app.getHttpServer())
      .get(path(provider).callback)
      .query(callbackQuery ?? { state: oauthState, code: `${provider}-code` })
      .redirects(0);
    const [base, search = ''] = (callback.headers['location'] as string).split('?');
    const params = new URLSearchParams(search);
    return {
      app_,
      authUrl,
      oauthState,
      base,
      state: params.get('state'),
      code: params.get('code'),
      error: params.get('error'),
    };
  }

  /** 로그인을 시작만 하고(콜백 전) 제공자에 보낸 oauthState를 돌려준다 */
  async function startOnly(provider: Provider) {
    const started = await request(app.getHttpServer())
      .get(path(provider).start)
      .query({
        redirect: APP_REDIRECT_URI,
        state: appSide().state,
        code_challenge: appSide().challenge,
        code_challenge_method: 'S256',
      })
      .redirects(0);
    return new URL(started.headers['location'] as string).searchParams.get('state')!;
  }

  const exchange = (provider: Provider, token: string | null, codeVerifier: string) =>
    request(app.getHttpServer()).post(path(provider).login).send({ token, codeVerifier });

  describe('시작', () => {
    it('카카오 로그인 화면(kauth.kakao.com)으로 보낸다', async () => {
      const step = await loginUntilCode('kakao');

      expect(step.authUrl.origin + step.authUrl.pathname).toBe(
        'https://kauth.kakao.com/oauth/authorize',
      );
      expect(step.authUrl.searchParams.get('client_id')).toBe(TEST_ENV.KAKAO_REST_API_KEY);
      expect(step.authUrl.searchParams.get('redirect_uri')).toBe(TEST_ENV.KAKAO_REDIRECT_URI);
    });

    it('카카오 로그인 주소에 앱의 state · PKCE 값이나 시크릿이 들어 있지 않다', async () => {
      const step = await loginUntilCode('kakao');
      const href = step.authUrl.href;

      expect(href).not.toContain(step.app_.state);
      expect(href).not.toContain(step.app_.challenge);
      expect(href).not.toContain(TEST_ENV.KAKAO_CLIENT_SECRET!);
    });

    it('시도는 kakao 제공자로 저장된다', async () => {
      await request(app.getHttpServer())
        .get(path('kakao').start)
        .query({
          redirect: APP_REDIRECT_URI,
          state: appSide().state,
          code_challenge: appSide().challenge,
          code_challenge_method: 'S256',
        })
        .redirects(0);

      expect(attempts.map((a) => a.provider)).toEqual(['kakao']);
    });
  });

  describe('성공 (새 사용자)', () => {
    it('앱이 하는 순서 그대로 따라가면 토큰과 사용자 정보를 받는다', async () => {
      const step = await loginUntilCode('kakao');
      expect(step.base).toBe(APP_REDIRECT_URI);
      expect(step.state).toBe(step.app_.state);
      expect(kakao.fetchProfile).toHaveBeenCalledWith('kakao-code');

      const res = await exchange('kakao', step.code, step.app_.codeVerifier);

      expect(res.status).toBe(200);
      expect(AuthTokens.safeParse(res.body.data).success).toBe(true);
      expect(res.body.data.user).toMatchObject({
        nickname: '카카오노트',
        email: 'student@example.com',
      });
      expect(Object.keys(res.body)).toEqual(['data']);
    });

    it('사용자는 kakao 소셜 계정(회원번호)과 함께 저장된다', async () => {
      const step = await loginUntilCode('kakao');

      await exchange('kakao', step.code, step.app_.codeVerifier);

      expect(users).toHaveLength(1);
      expect(users[0]!.socialAccounts).toEqual([
        expect.objectContaining({ provider: 'kakao', providerUid: '3912345678' }),
      ]);
      expect(users[0]!.passwordHash).toBeNull();
    });

    it('응답에 소셜 연동 정보 · 카카오 회원번호가 없다', async () => {
      const step = await loginUntilCode('kakao');

      const res = await exchange('kakao', step.code, step.app_.codeVerifier);

      expect(JSON.stringify(res.body)).not.toContain('3912345678');
      expect(JSON.stringify(res.body)).not.toContain('socialAccounts');
    });

    it('이메일이 없는 카카오 사용자도 로그인된다 (이메일 동의 안 함)', async () => {
      kakao.fetchProfile.mockResolvedValue({ ...KAKAO_PROFILE, email: null });
      const step = await loginUntilCode('kakao');

      const res = await exchange('kakao', step.code, step.app_.codeVerifier);

      expect(res.status).toBe(200);
      expect(users[0]!.email).toBeNull();
    });

    it('같은 카카오 계정으로 다시 로그인하면 같은 사용자 id를 받는다', async () => {
      const first = await loginUntilCode('kakao');
      const a = await exchange('kakao', first.code, first.app_.codeVerifier);
      const second = await loginUntilCode('kakao');
      const b = await exchange('kakao', second.code, second.app_.codeVerifier);

      expect(b.status).toBe(200);
      expect(a.body.data.user._id).toEqual(expect.any(String));
      expect(b.body.data.user._id).toBe(a.body.data.user._id);
      expect(users).toHaveLength(1);
    });
  });

  describe('구글과 카카오가 섞일 때', () => {
    it('두 제공자의 회원번호가 같은 값이어도 서로 다른 사용자다 (제공자까지 같아야 같은 사용자)', async () => {
      const sameUid = '12345';
      google.fetchProfile.mockResolvedValue({ providerUid: sameUid, email: null, name: '구글' });
      kakao.fetchProfile.mockResolvedValue({ providerUid: sameUid, email: null, name: '카카오' });

      const g = await loginUntilCode('google');
      const gRes = await exchange('google', g.code, g.app_.codeVerifier);
      const k = await loginUntilCode('kakao');
      const kRes = await exchange('kakao', k.code, k.app_.codeVerifier);

      expect(gRes.status).toBe(200);
      expect(kRes.status).toBe(200);
      expect(users).toHaveLength(2);
      expect(kRes.body.data.user._id).toEqual(expect.any(String));
      expect(kRes.body.data.user._id).not.toBe(gRes.body.data.user._id);
    });

    it('구글로 가입한 이메일을 카카오가 인증된 이메일로 가져오면 409이고 계정을 합치지 않는다', async () => {
      google.fetchProfile.mockResolvedValue({ ...GOOGLE_PROFILE, email: 'student@example.com' });
      const g = await loginUntilCode('google');
      await exchange('google', g.code, g.app_.codeVerifier);
      const k = await loginUntilCode('kakao');

      const res = await exchange('kakao', k.code, k.app_.codeVerifier);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ACCOUNT_EXISTS');
      expect(users).toHaveLength(1);
      expect(users[0]!.socialAccounts.map((s) => s.provider)).toEqual(['google']);
    });

    it('카카오로 받은 1회용 코드는 구글 교환 주소로는 쓸 수 없다', async () => {
      const k = await loginUntilCode('kakao');

      const res = await exchange('google', k.code, k.app_.codeVerifier);

      expect(res.status).toBe(400);
      expect(refreshTokens).toHaveLength(0);
    });

    // 한 제공자에서 시작한 로그인의 state를 다른 제공자의 콜백에 넣어도 시도를 찾지 못해야 한다(제공자까지 같아야 같은 시도)
    describe.each([
      ['kakao', 'google'],
      ['google', 'kakao'],
    ] as const)('%s에서 시작한 state를 %s 콜백에 넣으면', (from, to) => {
      const fetchOf = (p: Provider) => (p === 'kakao' ? kakao : google).fetchProfile;

      it('400 VALIDATION_FAILED로 거부하고 앱으로 돌려보내지 않는다', async () => {
        const oauthState = await startOnly(from);

        const res = await request(app.getHttpServer())
          .get(path(to).callback)
          .query({ state: oauthState, code: 'c' })
          .redirects(0);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
        // 앱으로 가는 리다이렉트(code · error 포함)가 아니다
        expect(res.headers['location']).toBeUndefined();
      });

      it('어느 제공자에도 묻지 않고, 시도는 점유되지 않은 채 남는다', async () => {
        const oauthState = await startOnly(from);
        fetchOf(from).mockClear();
        fetchOf(to).mockClear();

        await request(app.getHttpServer())
          .get(path(to).callback)
          .query({ state: oauthState, code: 'c' })
          .redirects(0);

        expect(fetchOf(from)).not.toHaveBeenCalled();
        expect(fetchOf(to)).not.toHaveBeenCalled();
        const attempt = attempts.find((a) => a.oauthState === oauthState);
        expect(attempt).toBeDefined();
        expect(attempt!.provider).toBe(from);
        expect(attempt!.codeHash).toBeNull();
      });

      it('잘못된 콜백 뒤에도 원래 제공자의 콜백으로는 정상 처리된다 (거부가 시도를 망가뜨리지 않는다)', async () => {
        const oauthState = await startOnly(from);
        await request(app.getHttpServer())
          .get(path(to).callback)
          .query({ state: oauthState, code: 'c' })
          .redirects(0);

        const ok = await request(app.getHttpServer())
          .get(path(from).callback)
          .query({ state: oauthState, code: `${from}-code` })
          .redirects(0);

        expect(ok.status).toBe(302);
        const location = new URL(
          (ok.headers['location'] as string).replace('notelink://', 'http://app/'),
        );
        expect(location.searchParams.get('code')).toBeTruthy();
        expect(location.searchParams.has('error')).toBe(false);
      });
    });
  });

  describe('카카오에서 실패하거나 취소한 경우', () => {
    it('사용자가 동의 화면에서 취소하면(error=access_denied) 앱에 access_denied로 돌려보낸다', async () => {
      const started = await request(app.getHttpServer())
        .get(path('kakao').start)
        .query({
          redirect: APP_REDIRECT_URI,
          state: appSide().state,
          code_challenge: appSide().challenge,
          code_challenge_method: 'S256',
        })
        .redirects(0);
      const oauthState = new URL(started.headers['location'] as string).searchParams.get('state')!;

      const res = await request(app.getHttpServer())
        .get(path('kakao').callback)
        .query({ state: oauthState, error: 'access_denied', error_description: 'user cancelled' })
        .redirects(0);

      const back = new URL(res.headers['location'] as string);
      expect(back.searchParams.get('error')).toBe('access_denied');
      expect(back.searchParams.has('code')).toBe(false);
      expect(kakao.fetchProfile).not.toHaveBeenCalled();
    });

    it('코드가 잘못됐으면(invalid_code) 앱에 invalid_code로 돌려보낸다', async () => {
      kakao.fetchProfile.mockRejectedValue(new SocialProviderError('invalid_code', '만료'));

      const step = await loginUntilCode('kakao');

      expect(step.error).toBe('invalid_code');
      expect(step.code).toBeNull();
    });

    it('카카오 장애면(unavailable) 앱에 unavailable로 돌려보낸다', async () => {
      kakao.fetchProfile.mockRejectedValue(new SocialProviderError('unavailable', '503'));

      const step = await loginUntilCode('kakao');

      expect(step.error).toBe('unavailable');
      expect(users).toHaveLength(0);
    });

    it('예상하지 못한 오류면(server_error) 앱에 server_error로 돌려보내고 오류 내용을 노출하지 않는다', async () => {
      kakao.fetchProfile.mockRejectedValue(new Error('boom: secret-detail'));

      const step = await loginUntilCode('kakao');

      expect(step.error).toBe('server_error');
      expect(step.base).toBe(APP_REDIRECT_URI);
      expect(users).toHaveLength(0);
    });
  });
});
