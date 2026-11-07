import { createHash, randomBytes } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { SocialLoginAttempt } from '../src/modules/auth/schemas/social-login-attempt.schema.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { GoogleOAuthClient } from '../src/modules/auth/social-login/google-oauth.client.js';
import { APP_REDIRECT_URI } from '../src/modules/auth/social-login/social-login.constants.js';
import { hashCode } from '../src/modules/auth/social-login/social-login.service.js';
import {
  type SocialProfile,
  SocialProviderError,
} from '../src/modules/auth/social-login/social-provider.js';
import { createAppModuleBuilder, stubAppEnv, TEST_ENV } from './support/app-module.js';

// 앱(apps/mobile/src/lib/social-auth.ts)이 만드는 값과 같은 방식으로 만든다
const appState = randomBytes(16).toString('hex');
const codeChallenge = createHash('sha256')
  .update(randomBytes(32).toString('hex'))
  .digest('base64url');

const START = '/api/v1/auth/social/google/start';
const CALLBACK = '/api/v1/auth/social/google/callback';

const START_QUERY = {
  redirect: APP_REDIRECT_URI,
  state: appState,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
};

const PROFILE: SocialProfile = {
  providerUid: '110169484474386276334',
  email: 'student@example.com',
  name: '김노트',
};

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
  socialAccounts: { provider: string; providerUid: string }[];
  deletedAt: Date | null;
  lastLoginAt: Date | null;
}

describe('구글 로그인: 시작 → 콜백 (구글만 가짜, 나머지는 실제 코드)', () => {
  let app: INestApplication;
  const attempts: Attempt[] = [];
  const users: UserRow[] = [];
  const google = { fetchProfile: vi.fn<(code: string) => Promise<SocialProfile>>() };

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
        filter: { provider: string; oauthState: string; codeHash: null; expiresAt: { $gt: Date } },
        update: { codeHash: string },
      ) => {
        const row = attempts.find(
          (a) =>
            a.provider === filter.provider &&
            a.oauthState === filter.oauthState &&
            a.codeHash === null &&
            a.expiresAt > filter.expiresAt.$gt,
        );
        if (!row) return Promise.resolve(null);
        const before = { ...row };
        row.codeHash = update.codeHash;
        return Promise.resolve(before);
      },
      updateOne: (filter: { _id: Types.ObjectId; codeHash?: string }, update: Partial<Attempt>) => {
        // 실제 Mongoose처럼 조건(_id, 점유한 코드 해시)에 맞는 문서에만 쓰고, 맞은 개수(matchedCount)를 돌려준다
        const row = attempts.find(
          (a) =>
            a._id.equals(filter._id) && (!('codeHash' in filter) || a.codeHash === filter.codeHash),
        );
        if (row) Object.assign(row, update);
        return Promise.resolve({ matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 });
      },
      deleteOne: (filter: { _id: Types.ObjectId; codeHash?: string }) => {
        const i = attempts.findIndex(
          (a) =>
            a._id.equals(filter._id) && (!('codeHash' in filter) || a.codeHash === filter.codeHash),
        );
        if (i >= 0) attempts.splice(i, 1);
        return Promise.resolve({});
      },
    };
    const usersModel = {
      findOneAndUpdate: (
        filter: { socialAccounts: { $elemMatch: { provider: string; providerUid: string } } },
        update: { lastLoginAt: Date },
      ) => {
        const m = filter.socialAccounts.$elemMatch;
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
      exists: (filter: { email: string }) => {
        const row = users.find((u) => u.email === filter.email && u.deletedAt === null);
        return Promise.resolve(row ? { _id: row._id } : null);
      },
      create: (data: Omit<UserRow, '_id' | 'deletedAt'>) => {
        const row: UserRow = { ...data, _id: new Types.ObjectId(), deletedAt: null };
        users.push(row);
        return Promise.resolve(row);
      },
    };
    const moduleRef = await createAppModuleBuilder()
      .overrideProvider(getModelToken(SocialLoginAttempt.name))
      .useValue(attemptsModel)
      .overrideProvider(getModelToken(User.name))
      .useValue(usersModel)
      .overrideProvider(GoogleOAuthClient)
      .useValue(google)
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
    google.fetchProfile.mockReset();
    google.fetchProfile.mockResolvedValue(PROFILE);
  });

  /** 앱이 하는 대로 시작해서, 구글이 콜백으로 돌려줄 state를 얻는다 */
  async function startLogin() {
    const res = await request(app.getHttpServer()).get(START).query(START_QUERY).redirects(0);
    const oauthState = new URL(res.headers['location'] as string).searchParams.get('state')!;
    return oauthState;
  }

  const callback = (query: Record<string, string>) =>
    request(app.getHttpServer()).get(CALLBACK).query(query).redirects(0);

  describe('정상 (새 사용자)', () => {
    it('앱 주소로 302: notelink://auth/callback?code=…&state=<앱 state>', async () => {
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, code: 'google-code' });

      expect(res.status).toBe(302);
      const location = res.headers['location'] as string;
      expect(location.startsWith('notelink://auth/callback?')).toBe(true);
      const params = new URLSearchParams(location.split('?')[1]);
      expect(params.get('state')).toBe(appState);
      expect(params.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('앱이 하는 검증(복귀 주소와 state가 정확히 같은가)을 통과한다', async () => {
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, code: 'google-code' });

      // apps/mobile/src/lib/social-auth.ts 와 같은 방식으로 확인한다
      const [base, search = ''] = (res.headers['location'] as string).split('?');
      const params = new URLSearchParams(search.split('#')[0]);
      expect(base).toBe(APP_REDIRECT_URI);
      expect(params.get('state')).toBe(appState);
      expect(params.get('code')).toBeTruthy();
    });

    it('구글에서 받은 사용자 정보로 새 사용자를 만든다', async () => {
      const oauthState = await startLogin();

      await callback({ state: oauthState, code: 'google-code' });

      expect(google.fetchProfile).toHaveBeenCalledExactlyOnceWith('google-code');
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        nickname: '김노트',
        email: 'student@example.com',
        socialAccounts: [{ provider: 'google', providerUid: PROFILE.providerUid }],
      });
    });

    it('로그인 시도에 결과 · 사용자 · 코드 해시를 기록한다', async () => {
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, code: 'google-code' });

      const code = new URLSearchParams((res.headers['location'] as string).split('?')[1]).get(
        'code',
      )!;
      expect(attempts[0]).toMatchObject({
        outcome: 'signed_in',
        userId: users[0]!._id,
        codeHash: hashCode(code),
        codeChallenge, // 코드 교환 때 PKCE 확인에 쓸 값이 그대로 남아 있다
      });
    });

    it('응답을 캐시하지 않게 한다 (앱 주소에 1회용 코드가 있다)', async () => {
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, code: 'google-code' });

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('client_secret이나 구글 코드가 응답에 나오지 않는다', async () => {
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, code: 'google-code-abc' });

      const everything = JSON.stringify(res.headers) + res.text;
      expect(everything).not.toContain(TEST_ENV.GOOGLE_CLIENT_SECRET);
      expect(everything).not.toContain('google-code-abc');
    });
  });

  describe('재로그인', () => {
    it('같은 구글 계정으로 다시 로그인하면 새 사용자를 만들지 않는다', async () => {
      const first = await startLogin();
      await callback({ state: first, code: 'c1' });
      const second = await startLogin();

      const res = await callback({ state: second, code: 'c2' });

      expect(res.status).toBe(302);
      expect(users).toHaveLength(1);
      expect(attempts.find((a) => a.oauthState === second)).toMatchObject({
        outcome: 'signed_in',
        userId: users[0]!._id,
      });
    });
  });

  describe('이메일이 겹침', () => {
    it('코드를 내주고 결과를 account_exists로 기록하며 새 사용자를 만들지 않는다', async () => {
      users.push({
        _id: new Types.ObjectId(),
        nickname: '앱가입자',
        email: 'student@example.com',
        socialAccounts: [],
        deletedAt: null,
        lastLoginAt: null,
      });
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, code: 'google-code' });

      expect(res.status).toBe(302);
      expect(
        new URLSearchParams((res.headers['location'] as string).split('?')[1]).get('code'),
      ).toBeTruthy();
      expect(attempts[0]).toMatchObject({ outcome: 'account_exists', userId: null });
      expect(users).toHaveLength(1);
      expect(users[0]!.socialAccounts).toEqual([]); // 합치지 않았다
    });
  });

  describe('사용자가 구글 화면에서 취소', () => {
    it('앱 주소로 302: error=access_denied&state=<앱 state> (code 없음)', async () => {
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, error: 'access_denied' });

      expect(res.status).toBe(302);
      const params = new URLSearchParams((res.headers['location'] as string).split('?')[1]);
      expect(params.get('error')).toBe('access_denied');
      expect(params.get('state')).toBe(appState);
      expect(params.get('code')).toBeNull();
      expect(google.fetchProfile).not.toHaveBeenCalled();
      expect(users).toHaveLength(0);
    });
  });

  describe('구글 · 서버 실패', () => {
    it.each([
      ['invalid_code', new SocialProviderError('invalid_code', 'x')],
      ['unavailable', new SocialProviderError('unavailable', 'x')],
    ])(
      '구글이 %s로 실패하면 앱 주소로 error를 돌려주고 사용자를 만들지 않는다',
      async (expected, failure) => {
        google.fetchProfile.mockRejectedValue(failure);
        const oauthState = await startLogin();

        const res = await callback({ state: oauthState, code: 'google-code' });

        expect(res.status).toBe(302);
        const params = new URLSearchParams((res.headers['location'] as string).split('?')[1]);
        expect(params.get('error')).toBe(expected);
        expect(params.get('state')).toBe(appState);
        expect(params.get('code')).toBeNull();
        expect(users).toHaveLength(0);
        expect(attempts).toHaveLength(0);
      },
    );
  });

  describe('앱으로 돌려보낼 수 없는 경우 (400)', () => {
    it('알 수 없는 state(가짜 콜백)이면 400 { code, message } 이고 구글에 묻지 않는다', async () => {
      const res = await callback({ state: 'x'.repeat(43), code: 'google-code' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
      expect(res.headers['location']).toBeUndefined();
      expect(google.fetchProfile).not.toHaveBeenCalled();
    });

    it('같은 콜백을 두 번 처리하지 않는다 (새로고침 · 뒤로가기)', async () => {
      const oauthState = await startLogin();
      await callback({ state: oauthState, code: 'google-code' });

      const res = await callback({ state: oauthState, code: 'google-code' });

      expect(res.status).toBe(400);
      expect(google.fetchProfile).toHaveBeenCalledTimes(1);
      expect(users).toHaveLength(1);
    });

    it('만료된 시도이면 400이다', async () => {
      const oauthState = await startLogin();
      attempts[0]!.expiresAt = new Date(Date.now() - 1000);

      const res = await callback({ state: oauthState, code: 'google-code' });

      expect(res.status).toBe(400);
      expect(google.fetchProfile).not.toHaveBeenCalled();
    });
  });

  describe('잘못된 쿼리', () => {
    it.each([
      ['state가 없음', {}],
      ['state가 너무 짧음', { state: 'short', code: 'c' }],
      ['state에 허용되지 않는 글자', { state: `${'a'.repeat(42)}!`, code: 'c' }],
    ])('%s이면 400 { code, message } 이고 구글에 묻지 않는다', async (_reason, query) => {
      const res = await callback(query as Record<string, string>);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
      expect(google.fetchProfile).not.toHaveBeenCalled();
    });

    it('code가 터무니없이 길면 구글에 보내지 않고 400이다', async () => {
      const oauthState = await startLogin();

      const res = await callback({ state: oauthState, code: 'x'.repeat(5000) });

      expect(res.status).toBe(400);
      expect(google.fetchProfile).not.toHaveBeenCalled();
    });

    it('같은 쿼리를 여러 번 보내도(배열) 거부한다', async () => {
      const oauthState = await startLogin();

      const res = await request(app.getHttpServer())
        .get(`${CALLBACK}?state=${oauthState}&state=${oauthState}&code=c`)
        .redirects(0);

      expect(res.status).toBe(400);
    });

    it('오류 응답에 받은 값을 되돌려 주지 않는다', async () => {
      const state = `${'q'.repeat(42)}!`;

      const res = await callback({ state, code: 'c' });

      expect(res.text).not.toContain(state);
    });
  });

  describe('주소와 메서드', () => {
    it('구글 콘솔에 등록한 주소(GOOGLE_REDIRECT_URI)와 경로가 같다', async () => {
      expect(new URL(TEST_ENV.GOOGLE_REDIRECT_URI!).pathname).toBe(CALLBACK);
    });

    it('POST는 받지 않는다 (콜백은 구글이 브라우저로 여는 GET이다)', async () => {
      const oauthState = await startLogin();

      const res = await request(app.getHttpServer())
        .post(CALLBACK)
        .query({ state: oauthState })
        .redirects(0);

      expect(res.status).toBe(404);
    });

    it('다른 제공자의 콜백 주소는 아직 없다', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/social/kakao/callback')
        .redirects(0);

      expect(res.status).toBe(404);
    });
  });
});
