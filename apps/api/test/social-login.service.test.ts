import { BadRequestException, Logger } from '@nestjs/common';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_CALLBACK_PATH, type GoogleConfig } from '../src/config/google.config.js';
import type { SocialLoginAttemptDocument } from '../src/modules/auth/schemas/social-login-attempt.schema.js';
import { GoogleOAuthClient } from '../src/modules/auth/social-login/google-oauth.client.js';
import {
  ATTEMPT_TTL_MS,
  CALLBACK_PROCESSING_MARGIN_MS,
  CODE_TTL_MS,
} from '../src/modules/auth/social-login/social-login.constants.js';
import {
  hashCode,
  SocialLoginService,
} from '../src/modules/auth/social-login/social-login.service.js';
import { SocialProviderRegistry } from '../src/modules/auth/social-login/social-provider-registry.js';
import {
  type SocialProfile,
  SocialProviderError,
} from '../src/modules/auth/social-login/social-provider.js';
import type {
  SocialUserResult,
  SocialUserService,
} from '../src/modules/auth/social-login/social-user.service.js';

const CONFIG: GoogleConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${GOOGLE_CALLBACK_PATH}`,
};

const PARAMS = { appState: 'a'.repeat(32), codeChallenge: 'c'.repeat(43) };
const PROFILE: SocialProfile = {
  providerUid: 'g-uid-1',
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

type ClaimFilter = {
  provider: string;
  oauthState: string;
  codeHash: null;
  expiresAt: { $gt: Date };
};

/**
 * social_login_attempts 컬렉션을 메모리로 흉내 낸다.
 * 서비스가 넘긴 조건(제공자 · 상태 · 코드가 비었는지 · 만료)을 그대로 적용해서, 조건이 빠지면 테스트가 잡아낸다.
 * findOneAndUpdate는 실제 Mongoose처럼 "바뀌기 전" 문서를 돌려주고, 찾기와 고치기를 한 번에 한다.
 */
function createFakeAttempts() {
  const rows: Attempt[] = [];
  const failures = { create: 0, deleteOne: 0, updateOne: 0 };
  // 결과를 저장하기 직전에 한 번 호출된다(처리하는 사이에 문서가 지워지거나 바뀌는 상황을 만든다)
  const hooks: { beforeUpdate?: () => void } = {};
  const model = {
    create: (data: Omit<Attempt, '_id' | 'userId' | 'codeHash' | 'outcome'>) => {
      if (failures.create > 0) {
        failures.create -= 1;
        return Promise.reject(new Error('DB 쓰기 실패'));
      }
      if (rows.some((r) => r.oauthState === data.oauthState)) {
        return Promise.reject(new Error('E11000 duplicate key (oauthState)'));
      }
      const row: Attempt = {
        ...data,
        _id: new Types.ObjectId(),
        userId: null,
        codeHash: null,
        outcome: null,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    findOneAndUpdate: (filter: ClaimFilter, update: { codeHash: string }) => {
      const row = rows.find(
        (r) =>
          r.provider === filter.provider &&
          r.oauthState === filter.oauthState &&
          r.codeHash === filter.codeHash &&
          r.expiresAt > filter.expiresAt.$gt,
      );
      if (!row) return Promise.resolve(null);
      const before = { ...row };
      row.codeHash = update.codeHash;
      return Promise.resolve(before);
    },
    updateOne: (filter: { _id: Types.ObjectId; codeHash?: string }, update: Partial<Attempt>) => {
      hooks.beforeUpdate?.();
      hooks.beforeUpdate = undefined;
      if (failures.updateOne > 0) {
        failures.updateOne -= 1;
        return Promise.reject(new Error('DB 갱신 실패'));
      }
      // 실제 Mongoose처럼 조건(_id, 점유한 코드 해시)에 맞는 문서에만 쓰고, 맞은 개수(matchedCount)를 돌려준다
      const row = rows.find(
        (r) =>
          r._id.equals(filter._id) && (!('codeHash' in filter) || r.codeHash === filter.codeHash),
      );
      if (row) Object.assign(row, update);
      return Promise.resolve({ matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 });
    },
    deleteOne: (filter: { _id: Types.ObjectId; codeHash?: string }) => {
      if (failures.deleteOne > 0) {
        failures.deleteOne -= 1;
        return Promise.reject(new Error('DB 삭제 실패'));
      }
      const i = rows.findIndex(
        (r) =>
          r._id.equals(filter._id) && (!('codeHash' in filter) || r.codeHash === filter.codeHash),
      );
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({ deletedCount: i >= 0 ? 1 : 0 });
    },
  } as unknown as Model<SocialLoginAttemptDocument>;
  return { rows, failures, hooks, model };
}

function setup(
  options: { profile?: () => Promise<SocialProfile>; user?: () => Promise<SocialUserResult> } = {},
) {
  const fake = createFakeAttempts();
  const userId = new Types.ObjectId();
  // 실제 구글 어댑터의 로그인 주소 만들기(buildAuthUrl)는 그대로 쓰고, 구글과 통신하는 fetchProfile만 가짜로 바꾼다
  const realGoogle = new GoogleOAuthClient(CONFIG);
  const googleClient = {
    name: 'google' as const,
    buildAuthUrl: (state: string) => realGoogle.buildAuthUrl(state),
    fetchProfile: vi.fn(options.profile ?? (() => Promise.resolve(PROFILE))),
  };
  const users = {
    findOrCreate: vi.fn(
      options.user ??
        (() => Promise.resolve({ kind: 'signed_in', userId, created: true } as SocialUserResult)),
    ),
  } as unknown as SocialUserService & { findOrCreate: ReturnType<typeof vi.fn> };
  const registry = new SocialProviderRegistry([googleClient]);
  const service = new SocialLoginService(registry, fake.model, users);
  return { service, ...fake, googleClient, users, userId };
}

/** 시작 → 구글이 돌려준 state를 꺼낸다 */
async function started(s: ReturnType<typeof setup>) {
  const href = await s.service.start('google', PARAMS);
  const oauthState = new URL(href).searchParams.get('state')!;
  return { href, oauthState };
}

const callbackOf = (
  oauthState: string,
  code: string | null = 'google-code',
  error: string | null = null,
) => ({
  oauthState,
  code,
  error,
});

const parse = (href: string) => {
  const url = new URL(href);
  return { base: `${url.protocol}//${url.host}${url.pathname}`, params: url.searchParams };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('SocialLoginService.startGoogle', () => {
  it('로그인 시도를 저장한다', async () => {
    const { service, rows } = setup();

    await service.start('google', PARAMS);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'google',
      appState: PARAMS.appState,
      codeChallenge: PARAMS.codeChallenge,
      userId: null,
      codeHash: null,
      outcome: null,
    });
  });

  it('구글로 보낼 주소를 돌려주고, 그 주소의 state는 저장한 oauthState와 같다', async () => {
    const s = setup();

    const { href, oauthState } = await started(s);

    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(oauthState).toBe(s.rows[0]!.oauthState);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('앱이 보낸 state · code_challenge는 구글로 보내지 않는다 (구글 구간용 state는 서버가 따로 만든다)', async () => {
    const s = setup();

    const { href } = await started(s);

    expect(s.rows[0]!.oauthState).not.toBe(PARAMS.appState);
    expect(href).not.toContain(PARAMS.appState);
    expect(href).not.toContain(PARAMS.codeChallenge);
  });

  it('oauthState는 추측할 수 없는 32바이트 base64url(43자)이다', async () => {
    const { service, rows } = setup();

    await service.start('google', PARAMS);

    expect(rows[0]!.oauthState).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('시작할 때마다 다른 oauthState를 만든다', async () => {
    const { service, rows } = setup();

    await Promise.all(Array.from({ length: 20 }, () => service.start('google', PARAMS)));

    expect(new Set(rows.map((a) => a.oauthState)).size).toBe(20);
  });

  it('만료 시각은 지금부터 정해진 시간(10분) 뒤이다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, rows } = setup();

    await service.start('google', PARAMS);

    expect(ATTEMPT_TTL_MS).toBe(10 * 60 * 1000);
    expect(rows[0]!.expiresAt.toISOString()).toBe('2026-01-01T00:10:00.000Z');
  });

  it('client_secret을 주소에도 저장 문서에도 넣지 않는다', async () => {
    const s = setup();

    const { href } = await started(s);

    expect(href).not.toContain(CONFIG.clientSecret);
    expect(JSON.stringify(s.rows)).not.toContain(CONFIG.clientSecret);
  });

  it('저장하지 못하면 주소를 돌려주지 않고 실패한다 (저장 안 된 시도로 구글에 보내지 않는다)', async () => {
    const { service, rows, failures } = setup();
    failures.create = 1;

    await expect(service.start('google', PARAMS)).rejects.toThrow('DB 쓰기 실패');

    expect(rows).toHaveLength(0);
  });
});

describe('SocialLoginService.handleGoogleCallback', () => {
  describe('정상 (새 사용자 · 재로그인)', () => {
    it('앱으로 notelink://auth/callback?code=…&state=<앱 state> 를 돌려준다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      const { base, params } = parse(href);
      expect(base).toBe('notelink://auth/callback');
      expect(params.get('state')).toBe(PARAMS.appState);
      expect(params.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(params.get('error')).toBeNull();
    });

    it('앱에는 앱이 보낸 state를 돌려주고, 구글 구간의 oauthState는 돌려주지 않는다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(href).not.toContain(oauthState);
      expect(parse(href).params.get('state')).toBe(PARAMS.appState);
    });

    it('구글에 받은 코드를 보내 사용자 정보를 받고, 그 정보로 사용자를 찾거나 만든다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      await s.service.handleCallback('google', callbackOf(oauthState, 'the-google-code'));

      expect(s.googleClient.fetchProfile).toHaveBeenCalledExactlyOnceWith('the-google-code', {
        oauthState,
      });
      expect(s.users.findOrCreate).toHaveBeenCalledExactlyOnceWith('google', PROFILE);
    });

    it('결과(signed_in)와 사용자 id를 시도에 기록한다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      await s.service.handleCallback('google', callbackOf(oauthState));

      expect(s.rows[0]).toMatchObject({ outcome: 'signed_in', userId: s.userId });
    });

    it('앱에 내준 코드는 원문이 아니라 해시로 저장한다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      const code = parse(href).params.get('code')!;
      expect(s.rows[0]!.codeHash).toBe(hashCode(code));
      expect(JSON.stringify(s.rows)).not.toContain(code);
      expect(s.rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('코드의 수명을 짧게(2분) 줄인다', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const s = setup();
      const { oauthState } = await started(s);
      vi.setSystemTime(new Date('2026-01-01T00:03:00Z')); // 로그인 시작 3분 뒤 구글에서 돌아옴

      await s.service.handleCallback('google', callbackOf(oauthState));

      expect(CODE_TTL_MS).toBe(2 * 60 * 1000);
      expect(s.rows[0]!.expiresAt.toISOString()).toBe('2026-01-01T00:05:00.000Z');
    });

    it('시도마다 서로 다른 코드를 내준다', async () => {
      const s = setup();
      const codes = new Set<string>();

      for (let i = 0; i < 20; i++) {
        const { oauthState } = await started(s);
        const href = await s.service.handleCallback('google', callbackOf(oauthState));
        codes.add(parse(href).params.get('code')!);
      }

      expect(codes.size).toBe(20);
    });

    it('client_secret이나 구글 코드를 앱 주소에 싣지 않는다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback(
        'google',
        callbackOf(oauthState, 'the-google-code'),
      );

      expect(href).not.toContain(CONFIG.clientSecret);
      expect(href).not.toContain('the-google-code');
    });
  });

  describe('이메일이 겹침 (account_exists)', () => {
    const exists = () => Promise.resolve({ kind: 'account_exists' } as SocialUserResult);

    it('코드를 내주고(앱이 코드 교환에서 안내를 받도록) 결과를 account_exists로 기록한다', async () => {
      const s = setup({ user: exists });
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(parse(href).params.get('code')).not.toBeNull();
      expect(parse(href).params.get('state')).toBe(PARAMS.appState);
      expect(s.rows[0]).toMatchObject({ outcome: 'account_exists', userId: null });
    });
  });

  describe('state로 로그인 시도를 찾지 못함 (앱으로 돌려보낼 수 없다)', () => {
    it.each([['알 수 없는 state(가짜 콜백)', () => 'x'.repeat(43)]])(
      '%s이면 400 { code, message } 이고 구글에 묻지 않는다',
      async (_reason, stateOf) => {
        const s = setup();
        await started(s);

        const error = await s.service
          .handleCallback('google', callbackOf(stateOf()))
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          code: 'VALIDATION_FAILED',
        });
        expect(s.googleClient.fetchProfile).not.toHaveBeenCalled();
        expect(s.users.findOrCreate).not.toHaveBeenCalled();
      },
    );

    it('만료된 시도이면 400이고 구글에 묻지 않는다', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const s = setup();
      const { oauthState } = await started(s);
      vi.setSystemTime(new Date('2026-01-01T00:10:01Z')); // 10분 + 1초 뒤

      const error = await s.service
        .handleCallback('google', callbackOf(oauthState))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.googleClient.fetchProfile).not.toHaveBeenCalled();
    });

    // 처리(구글 호출 최대 5초 x 2 + 사용자 처리)를 마칠 시간이 남아 있을 때만 점유한다
    it('만료까지 처리 여유(30초)보다 많이 남았으면 정상 처리한다', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const s = setup();
      const { oauthState } = await started(s); // 만료: 00:10:00
      vi.setSystemTime(new Date('2026-01-01T00:09:29Z')); // 31초 남음

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(CALLBACK_PROCESSING_MARGIN_MS).toBe(30 * 1000);
      expect(parse(href).params.get('code')).not.toBeNull();
    });

    it('만료까지 정확히 30초 남았으면 점유하지 않는다 (경계값)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const s = setup();
      const { oauthState } = await started(s);
      vi.setSystemTime(new Date('2026-01-01T00:09:30Z')); // 정확히 30초 남음

      const error = await s.service
        .handleCallback('google', callbackOf(oauthState))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.googleClient.fetchProfile).not.toHaveBeenCalled();
    });

    it('만료까지 30초가 안 남았으면 처리를 시작하지 않는다 (사용자를 만들지 않고, 구글에 묻지 않는다)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const s = setup();
      const { oauthState } = await started(s);
      vi.setSystemTime(new Date('2026-01-01T00:09:59Z')); // 1초 남음

      const error = await s.service
        .handleCallback('google', callbackOf(oauthState))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.googleClient.fetchProfile).not.toHaveBeenCalled();
      expect(s.users.findOrCreate).not.toHaveBeenCalled();
    });

    it('오류 응답에 받은 state를 되돌려 주지 않는다', async () => {
      const s = setup();
      const state = 'z'.repeat(43);

      const error = (await s.service
        .handleCallback('google', callbackOf(state))
        .catch((e: unknown) => e)) as BadRequestException;

      expect(JSON.stringify(error.getResponse())).not.toContain(state);
    });
  });

  describe('같은 콜백이 여러 번 오는 경우 (새로고침 · 뒤로가기 · 동시 요청)', () => {
    it('이미 처리된 state로 다시 오면 400이고 구글에 다시 묻지 않는다', async () => {
      const s = setup();
      const { oauthState } = await started(s);
      await s.service.handleCallback('google', callbackOf(oauthState));

      const error = await s.service
        .handleCallback('google', callbackOf(oauthState))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.googleClient.fetchProfile).toHaveBeenCalledTimes(1);
      expect(s.users.findOrCreate).toHaveBeenCalledTimes(1);
    });

    it('동시에 두 번 오면 한 번만 처리하고 코드는 하나만 내준다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const results = await Promise.allSettled([
        s.service.handleCallback('google', callbackOf(oauthState)),
        s.service.handleCallback('google', callbackOf(oauthState)),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(s.users.findOrCreate).toHaveBeenCalledTimes(1);
    });

    it('동시에 20번 와도 사용자 처리는 한 번만 일어난다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          s.service.handleCallback('google', callbackOf(oauthState)),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(s.users.findOrCreate).toHaveBeenCalledTimes(1);
    });

    it('실패한 시도(취소)로 다시 와도 처리되지 않는다 (지워졌다)', async () => {
      const s = setup();
      const { oauthState } = await started(s);
      await s.service.handleCallback('google', callbackOf(oauthState, null, 'access_denied'));

      const error = await s.service
        .handleCallback('google', callbackOf(oauthState))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.googleClient.fetchProfile).not.toHaveBeenCalled();
    });
  });

  describe('사용자가 취소했거나 코드가 없음', () => {
    it('구글이 access_denied를 주면 앱으로 error=access_denied 와 앱 state를 돌려준다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback(
        'google',
        callbackOf(oauthState, null, 'access_denied'),
      );

      const { base, params } = parse(href);
      expect(base).toBe('notelink://auth/callback');
      expect(params.get('error')).toBe('access_denied');
      expect(params.get('state')).toBe(PARAMS.appState);
      expect(params.get('code')).toBeNull();
    });

    it('다른 오류 문자열은 그대로 넘기지 않고 invalid_code로 바꾼다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback(
        'google',
        callbackOf(oauthState, null, '<script>alert(1)</script>'),
      );

      expect(parse(href).params.get('error')).toBe('invalid_code');
      expect(href).not.toContain('script');
    });

    it('오류도 코드도 없으면 invalid_code이다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState, null, null));

      expect(parse(href).params.get('error')).toBe('invalid_code');
    });

    it('오류가 있으면 코드가 함께 와도 구글에 묻지 않는다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      await s.service.handleCallback(
        'google',
        callbackOf(oauthState, 'some-code', 'access_denied'),
      );

      expect(s.googleClient.fetchProfile).not.toHaveBeenCalled();
    });

    it('실패한 시도는 지워서 코드가 쓰이지 못하게 한다', async () => {
      const s = setup();
      const { oauthState } = await started(s);

      await s.service.handleCallback('google', callbackOf(oauthState, null, 'access_denied'));

      expect(s.rows).toHaveLength(0);
    });
  });

  describe('구글 · 서버 실패', () => {
    it.each([
      [
        '코드 교환 거부(invalid_code)',
        new SocialProviderError('invalid_code', 'x'),
        'invalid_code',
      ],
      ['구글 장애(unavailable)', new SocialProviderError('unavailable', 'x'), 'unavailable'],
    ])('%s이면 앱으로 error=%s 를 돌려주고 시도를 지운다', async (_reason, failure, expected) => {
      const s = setup({ profile: () => Promise.reject(failure) });
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(parse(href).params.get('error')).toBe(expected);
      expect(parse(href).params.get('state')).toBe(PARAMS.appState);
      expect(parse(href).params.get('code')).toBeNull();
      expect(s.rows).toHaveLength(0);
      expect(s.users.findOrCreate).not.toHaveBeenCalled();
    });

    it('구글 통신 실패는 운영자가 원인을 알 수 있게 서버 로그에 남기고, 비밀값은 남기지 않는다', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const s = setup({
        profile: () =>
          Promise.reject(new SocialProviderError('unavailable', '구글 코드 교환 응답 상태: 401')),
      });
      const { oauthState } = await started(s);

      await s.service.handleCallback('google', callbackOf(oauthState, 'google-code-xyz'));

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = String(warn.mock.calls[0]![0]);
      expect(logged).toContain('401');
      expect(logged).toContain('unavailable');
      expect(logged).not.toContain('google-code-xyz');
      expect(logged).not.toContain(CONFIG.clientSecret);
      warn.mockRestore();
    });

    it('사용자 처리에서 예상 못 한 오류가 나면 error=server_error 를 돌려주고 시도를 지운다', async () => {
      const s = setup({ user: () => Promise.reject(new Error('DB 연결 끊김')) });
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(parse(href).params.get('error')).toBe('server_error');
      expect(s.rows).toHaveLength(0);
    });

    it('예상 못 한 오류의 내용(비밀값이 있을 수 있다)을 앱에 보내지 않는다', async () => {
      const secret = 'secret-inside-error-message';
      const s = setup({ user: () => Promise.reject(new Error(secret)) });
      const { oauthState } = await started(s);

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(href).not.toContain(secret);
    });

    it('결과를 기록하지 못하면(DB 갱신 실패) 코드를 내주지 않고 server_error를 돌려준다', async () => {
      const s = setup();
      const { oauthState } = await started(s);
      s.failures.updateOne = 1;

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(parse(href).params.get('error')).toBe('server_error');
      expect(parse(href).params.get('code')).toBeNull();
      expect(s.rows).toHaveLength(0);
    });

    describe('결과를 저장하는 사이에 로그인 시도가 사라지거나 바뀐 경우 (matchedCount 확인)', () => {
      const warnSpy = () => vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      it('처리하는 사이에 문서가 지워지면(만료 · TTL 삭제) 코드를 내주지 않고 invalid_code를 돌려준다', async () => {
        const warn = warnSpy();
        const s = setup();
        const { oauthState } = await started(s);
        s.hooks.beforeUpdate = () => s.rows.splice(0, s.rows.length); // 구글 호출 후 저장 직전에 문서가 사라짐

        const href = await s.service.handleCallback('google', callbackOf(oauthState));

        const { params } = parse(href);
        expect(params.get('error')).toBe('invalid_code');
        expect(params.get('state')).toBe(PARAMS.appState);
        expect(params.get('code')).toBeNull();
        warn.mockRestore();
      });

      it('저장 대상이 없으면(matchedCount 0) 서버 로그에 남긴다', async () => {
        const warn = warnSpy();
        const s = setup();
        const { oauthState } = await started(s);
        s.hooks.beforeUpdate = () => s.rows.splice(0, s.rows.length);

        await s.service.handleCallback('google', callbackOf(oauthState));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('사라졌');
        warn.mockRestore();
      });

      it('내가 점유한 코드가 아니게 바뀐 문서에는 결과를 쓰지 않고, 남의 문서를 지우지도 않는다', async () => {
        const warn = warnSpy();
        const s = setup();
        const { oauthState } = await started(s);
        s.hooks.beforeUpdate = () => {
          s.rows[0]!.codeHash = 'somebody-elses-hash'; // 점유가 다른 쪽으로 넘어간 상황
        };

        const href = await s.service.handleCallback('google', callbackOf(oauthState));

        expect(parse(href).params.get('code')).toBeNull();
        expect(parse(href).params.get('error')).toBe('invalid_code');
        // 결과가 쓰이지 않았고, 남이 점유한 문서가 그대로 남아 있다
        expect(s.rows).toHaveLength(1);
        expect(s.rows[0]).toMatchObject({
          codeHash: 'somebody-elses-hash',
          outcome: null,
          userId: null,
        });
        warn.mockRestore();
      });

      it('문서가 사라졌어도 앱에는 오류만 돌려주고 예외를 던지지 않는다', async () => {
        const warn = warnSpy();
        const s = setup();
        const { oauthState } = await started(s);
        s.hooks.beforeUpdate = () => s.rows.splice(0, s.rows.length);

        await expect(s.service.handleCallback('google', callbackOf(oauthState))).resolves.toContain(
          'error=',
        );
        warn.mockRestore();
      });

      it('정상일 때는 matchedCount가 1이라 코드를 내준다', async () => {
        const s = setup();
        const { oauthState } = await started(s);

        const href = await s.service.handleCallback('google', callbackOf(oauthState));

        expect(parse(href).params.get('code')).not.toBeNull();
        expect(s.rows[0]!.outcome).toBe('signed_in');
      });
    });

    it('시도를 지우지 못해도(DB 삭제 실패) 앱에는 오류를 돌려준다', async () => {
      const s = setup({
        profile: () => Promise.reject(new SocialProviderError('unavailable', 'x')),
      });
      const { oauthState } = await started(s);
      s.failures.deleteOne = 1;

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(parse(href).params.get('error')).toBe('unavailable');
    });

    it('실패한 시도의 점유된 코드는 쓸 수 없다 (지우지 못했어도 앱에 코드를 내주지 않았다)', async () => {
      const s = setup({
        profile: () => Promise.reject(new SocialProviderError('unavailable', 'x')),
      });
      const { oauthState } = await started(s);
      s.failures.deleteOne = 1;

      const href = await s.service.handleCallback('google', callbackOf(oauthState));

      expect(parse(href).params.get('code')).toBeNull();
      expect(s.rows[0]!.userId).toBeNull(); // 사용자와 연결되지 않은 채 점유 상태로만 남는다
      expect(s.rows[0]!.outcome).toBeNull();
    });
  });
});
