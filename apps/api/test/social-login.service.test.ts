import type { Model } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_CALLBACK_PATH, type GoogleConfig } from '../src/config/google.config.js';
import type { SocialLoginAttemptDocument } from '../src/modules/auth/schemas/social-login-attempt.schema.js';
import { ATTEMPT_TTL_MS } from '../src/modules/auth/social-login/social-login.constants.js';
import { SocialLoginService } from '../src/modules/auth/social-login/social-login.service.js';

const CONFIG: GoogleConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${GOOGLE_CALLBACK_PATH}`,
};

const PARAMS = { appState: 'a'.repeat(32), codeChallenge: 'c'.repeat(43) };

interface SavedAttempt {
  provider: string;
  oauthState: string;
  appState: string;
  codeChallenge: string;
  expiresAt: Date;
}

/** social_login_attempts 컬렉션을 메모리로 흉내 낸다. 서비스가 쓰는 create만 만든다 */
function setup() {
  const saved: SavedAttempt[] = [];
  const failures = { create: 0 };
  const model = {
    create: (data: SavedAttempt) => {
      if (failures.create > 0) {
        failures.create -= 1;
        return Promise.reject(new Error('DB 쓰기 실패'));
      }
      if (saved.some((a) => a.oauthState === data.oauthState)) {
        return Promise.reject(new Error('E11000 duplicate key (oauthState)'));
      }
      saved.push(data);
      return Promise.resolve(data);
    },
  } as unknown as Model<SocialLoginAttemptDocument>;
  return { service: new SocialLoginService(CONFIG, model), saved, failures };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SocialLoginService.startGoogle', () => {
  it('로그인 시도를 저장한다', async () => {
    const { service, saved } = setup();

    await service.startGoogle(PARAMS);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      provider: 'google',
      appState: PARAMS.appState,
      codeChallenge: PARAMS.codeChallenge,
    });
  });

  it('구글로 보낼 주소를 돌려주고, 그 주소의 state는 저장한 oauthState와 같다', async () => {
    const { service, saved } = setup();

    const href = await service.startGoogle(PARAMS);

    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('state')).toBe(saved[0]!.oauthState);
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('앱이 보낸 state는 구글로 보내지 않는다 (구글 구간용 state는 서버가 따로 만든다)', async () => {
    const { service, saved } = setup();

    const href = await service.startGoogle(PARAMS);

    expect(saved[0]!.oauthState).not.toBe(PARAMS.appState);
    expect(href).not.toContain(PARAMS.appState);
    expect(href).not.toContain(PARAMS.codeChallenge);
  });

  it('oauthState는 추측할 수 없는 32바이트 base64url(43자)이다', async () => {
    const { service, saved } = setup();

    await service.startGoogle(PARAMS);

    expect(saved[0]!.oauthState).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('시작할 때마다 다른 oauthState를 만든다', async () => {
    const { service, saved } = setup();

    await Promise.all(Array.from({ length: 20 }, () => service.startGoogle(PARAMS)));

    expect(new Set(saved.map((a) => a.oauthState)).size).toBe(20);
  });

  it('만료 시각은 지금부터 정해진 시간(10분) 뒤이다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service, saved } = setup();

    await service.startGoogle(PARAMS);

    expect(ATTEMPT_TTL_MS).toBe(10 * 60 * 1000);
    expect(saved[0]!.expiresAt.toISOString()).toBe('2026-01-01T00:10:00.000Z');
  });

  it('client_secret을 주소에도 저장 문서에도 넣지 않는다', async () => {
    const { service, saved } = setup();

    const href = await service.startGoogle(PARAMS);

    expect(href).not.toContain(CONFIG.clientSecret);
    expect(JSON.stringify(saved)).not.toContain(CONFIG.clientSecret);
  });

  it('저장하지 못하면 주소를 돌려주지 않고 실패한다 (저장 안 된 시도로 구글에 보내지 않는다)', async () => {
    const { service, saved, failures } = setup();
    failures.create = 1;

    await expect(service.startGoogle(PARAMS)).rejects.toThrow('DB 쓰기 실패');

    expect(saved).toHaveLength(0);
  });
});
