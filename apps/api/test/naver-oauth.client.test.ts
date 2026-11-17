import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NAVER_CALLBACK_PATH, type NaverConfig } from '../src/config/naver.config.js';
import { NaverOAuthClient } from '../src/modules/auth/social-login/naver-oauth.client.js';
import { SocialProviderError } from '../src/modules/auth/social-login/social-provider.js';

const CONFIG: NaverConfig = {
  clientId: 'test-naver-client-id',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${NAVER_CALLBACK_PATH}`,
};

const CODE = 'naver-one-time-code-do-not-leak';
const ACCESS_TOKEN = 'naver-access-token-do-not-leak';
const OAUTH_STATE = 'oauth-state-from-our-server';
const CONTEXT = { oauthState: OAUTH_STATE };

const TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';
const PROFILE_URL = 'https://openapi.naver.com/v1/nid/me';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** 네이버 사용자 정보 조회 응답 (이메일 · 실명도 내려오지만 쓰지 않는다) */
const PROFILE = {
  resultcode: '00',
  message: 'success',
  response: {
    id: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdE',
    nickname: '노트링크',
    name: '김실명',
    email: 'student@naver.com',
    profile_image: 'https://ssl.pstatic.net/x.png',
  },
};

type Call = { url: string; init: RequestInit };
type Responder = (call: Call) => Response | Promise<Response>;

/** fetch를 가짜로 바꾼다. 주소별로 돌려줄 응답을 정하고, 보낸 요청을 기록한다 */
function stubFetch(respond: Record<string, Responder>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      const handler = respond[url];
      if (!handler) throw new Error(`예상하지 못한 요청: ${url}`);
      return handler(call);
    }),
  );
  return calls;
}

const normal = (): Record<string, Responder> => ({
  [TOKEN_URL]: () =>
    json({
      access_token: ACCESS_TOKEN,
      refresh_token: 'r',
      token_type: 'bearer',
      expires_in: '3600',
    }),
  [PROFILE_URL]: () => json(PROFILE),
});

/** 정상 응답에서 response 일부만 바꾼다 */
const withProfile = (change: Record<string, unknown>) => () =>
  json({ ...PROFILE, response: { ...PROFILE.response, ...change } });

function client() {
  return new NaverOAuthClient(CONFIG);
}

async function failure(promise: Promise<unknown>): Promise<SocialProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SocialProviderError);
    return error as SocialProviderError;
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NaverOAuthClient', () => {
  it('제공자 이름은 naver이다', () => {
    expect(client().name).toBe('naver');
  });

  it('로그인 주소는 네이버 인가 주소이고 state를 담는다', () => {
    const url = new URL(client().buildAuthUrl('state-abc'));

    expect(url.origin + url.pathname).toBe('https://nid.naver.com/oauth2.0/authorize');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.clientId);
  });
});

describe('NaverOAuthClient.fetchProfile', () => {
  describe('코드 교환 요청', () => {
    it('네이버 토큰 주소에 form 본문으로 POST한다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE, CONTEXT);

      expect(calls[0]!.url).toBe(TOKEN_URL);
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[0]!.init.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      });
    });

    it('grant_type · client_id · client_secret · code · state를 보낸다 (네이버는 state를 다시 요구한다)', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE, CONTEXT);

      expect(Object.fromEntries(calls[0]!.init.body as URLSearchParams)).toEqual({
        grant_type: 'authorization_code',
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        code: CODE,
        state: OAUTH_STATE,
      });
    });

    it('비밀값을 주소(쿼리)에 싣지 않는다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE, CONTEXT);

      for (const call of calls) {
        expect(call.url).not.toContain(CONFIG.clientSecret);
        expect(call.url).not.toContain(CODE);
        expect(call.url).not.toContain('?');
      }
    });

    it('시간 제한(signal)을 걸고, 리다이렉트는 따라가지 않는다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE, CONTEXT);

      for (const call of calls) {
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
        expect(call.init.redirect).toBe('error');
      }
    });
  });

  describe('사용자 정보 요청', () => {
    it('받은 access_token을 Bearer로 붙여 프로필을 GET한다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE, CONTEXT);

      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toBe(PROFILE_URL);
      expect(calls[1]!.init.method).toBeUndefined();
      expect(calls[1]!.init.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    });

    it('코드 교환이 실패하면 프로필은 부르지 않는다', async () => {
      const calls = stubFetch({
        ...normal(),
        [TOKEN_URL]: () => json({ error: 'invalid_request' }, 400),
      });

      await failure(client().fetchProfile(CODE, CONTEXT));

      expect(calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    });
  });

  describe('정상 응답', () => {
    it('이용자 식별자(id)와 별명(nickname)을 돌려준다', async () => {
      stubFetch(normal());

      await expect(client().fetchProfile(CODE, CONTEXT)).resolves.toEqual({
        providerUid: PROFILE.response.id,
        email: null,
        name: '노트링크',
      });
    });

    it('이메일은 인증 여부를 알 수 없어 응답에 있어도 저장하지 않는다 (항상 null)', async () => {
      stubFetch(normal());

      expect((await client().fetchProfile(CODE, CONTEXT)).email).toBeNull();
    });

    it('실명(name)은 닉네임 초기값으로 쓰지 않는다 (별명이 없으면 null)', async () => {
      stubFetch({ ...normal(), [PROFILE_URL]: withProfile({ nickname: undefined }) });

      expect((await client().fetchProfile(CODE, CONTEXT)).name).toBeNull();
    });

    it('별명의 앞뒤 공백을 지운다', async () => {
      stubFetch({ ...normal(), [PROFILE_URL]: withProfile({ nickname: '  노트링크 ' }) });

      expect((await client().fetchProfile(CODE, CONTEXT)).name).toBe('노트링크');
    });

    it.each([
      ['별명이 빈 문자열', ''],
      ['별명이 공백뿐', '   '],
      ['별명이 문자열이 아님', 7],
    ])('%s이면 name은 null이다', async (_reason, nickname) => {
      stubFetch({ ...normal(), [PROFILE_URL]: withProfile({ nickname }) });

      expect((await client().fetchProfile(CODE, CONTEXT)).name).toBeNull();
    });

    it('응답의 다른 값(실명 · 이메일 · 사진 등)은 결과에 넣지 않는다', async () => {
      stubFetch(normal());

      expect(Object.keys(await client().fetchProfile(CODE, CONTEXT)).sort()).toEqual([
        'email',
        'name',
        'providerUid',
      ]);
    });

    it('id는 문자열 그대로 돌려준다 (가공하지 않는다)', async () => {
      stubFetch({ ...normal(), [PROFILE_URL]: withProfile({ id: 'abc-_123' }) });

      expect((await client().fetchProfile(CODE, CONTEXT)).providerUid).toBe('abc-_123');
    });
  });

  describe('코드가 잘못된 경우 (invalid_code)', () => {
    it('코드 교환이 400이면 invalid_code이다', async () => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json({ error: 'invalid_request' }, 400) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('invalid_code');
    });

    it.each(['invalid_request', 'invalid_grant', 'access_denied'])(
      '코드 교환이 200이어도 본문에 error=%s가 있으면 invalid_code이다 (네이버는 오류도 200으로 줄 수 있다)',
      async (error) => {
        stubFetch({
          ...normal(),
          [TOKEN_URL]: () => json({ error, error_description: 'authorization code not found' }),
        });

        expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('invalid_code');
      },
    );

    it('코드가 빈 문자열이면 네이버에 묻지 않고 invalid_code이다', async () => {
      const calls = stubFetch(normal());

      const error = await failure(client().fetchProfile('', CONTEXT));

      expect(error.reason).toBe('invalid_code');
      expect(calls).toHaveLength(0);
    });
  });

  describe('네이버 · 네트워크 · 설정 문제 (unavailable)', () => {
    it.each(['invalid_client', 'unauthorized_client', 'server_error', 'something_else'])(
      '코드 교환이 200이어도 본문에 error=%s가 있으면 unavailable이다 (우리 설정 · 네이버 문제)',
      async (error) => {
        stubFetch({ ...normal(), [TOKEN_URL]: () => json({ error }) });

        expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
      },
    );

    it('error 값이 문자열이 아니어도 실패로 본다 (unavailable)', async () => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json({ error: { a: 1 } }) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it.each([
      ['401 (client_id · secret이 틀림)', 401],
      ['403', 403],
      ['429', 429],
      ['500', 500],
      ['503', 503],
    ])('코드 교환이 %s이면 unavailable이다', async (_reason, status) => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json({ error: 'x' }, status) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it.each([400, 401, 500])('프로필이 HTTP %i이면 unavailable이다', async (status) => {
      stubFetch({ ...normal(), [PROFILE_URL]: () => json({ message: 'x' }, status) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it.each([
      ['01', '인증 실패'],
      ['024', 'Authentication failed'],
      ['', '빈 값'],
    ])('프로필이 200이어도 resultcode=%s(%s)이면 unavailable이다', async (resultcode) => {
      stubFetch({
        ...normal(),
        [PROFILE_URL]: () => json({ ...PROFILE, resultcode, message: 'fail' }),
      });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it('resultcode가 없으면 unavailable이다', async () => {
      stubFetch({ ...normal(), [PROFILE_URL]: () => json({ response: PROFILE.response }) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it('resultcode가 숫자 0이면 성공으로 보지 않는다 (정확히 문자열 "00"만 성공)', async () => {
      stubFetch({ ...normal(), [PROFILE_URL]: () => json({ ...PROFILE, resultcode: 0 }) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it('네트워크가 끊기면(fetch가 거부됨) unavailable이다', async () => {
      stubFetch({
        ...normal(),
        [TOKEN_URL]: () => {
          throw new TypeError('fetch failed');
        },
      });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it('시간 제한에 걸려도(TimeoutError) unavailable이다', async () => {
      stubFetch({
        ...normal(),
        [PROFILE_URL]: () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it.each([
      ['access_token이 없음', {}],
      ['access_token이 빈 문자열', { access_token: '' }],
      ['access_token이 문자열이 아님', { access_token: 123 }],
    ])('코드 교환 응답에서 %s이면 unavailable이다', async (_reason, body) => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json(body) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it.each([
      ['response가 없음', { resultcode: '00', message: 'success' }],
      ['response가 객체가 아님', { resultcode: '00', response: 'x' }],
      ['id가 없음', { resultcode: '00', response: { nickname: 'a' } }],
      ['id가 빈 문자열', { resultcode: '00', response: { id: '' } }],
      ['id가 공백뿐', { resultcode: '00', response: { id: '   ' } }],
      ['id가 숫자', { resultcode: '00', response: { id: 123 } }],
    ])('프로필에서 %s이면 unavailable이다 (사용자를 구분할 수 없다)', async (_reason, body) => {
      stubFetch({ ...normal(), [PROFILE_URL]: () => json(body) });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });

    it.each([
      ['JSON이 아님', () => new Response('<html>oops</html>', { status: 200 })],
      ['배열', () => json([1, 2, 3])],
      ['null', () => json(null)],
    ])('프로필 응답이 %s이면 unavailable이다', async (_reason, respond) => {
      stubFetch({ ...normal(), [PROFILE_URL]: respond });

      expect((await failure(client().fetchProfile(CODE, CONTEXT))).reason).toBe('unavailable');
    });
  });

  describe('오류에 비밀값을 남기지 않는다', () => {
    const secrets = [CODE, ACCESS_TOKEN, CONFIG.clientSecret, OAUTH_STATE];

    it.each([
      [
        '코드 교환 200 + error (설명에 코드가 섞임)',
        {
          [TOKEN_URL]: () =>
            json({
              error: 'invalid_request',
              error_description: `code ${CODE} state ${OAUTH_STATE}`,
            }),
        },
      ],
      ['코드 교환 400', { [TOKEN_URL]: () => json({ error: 'invalid_grant', code: CODE }, 400) }],
      ['코드 교환 500', { [TOKEN_URL]: () => json({ secret: CONFIG.clientSecret }, 500) }],
      ['코드 교환 응답이 이상함', { [TOKEN_URL]: () => json({ access_token: 123, v: CODE }) }],
      ['프로필 500', { [PROFILE_URL]: () => json({ t: ACCESS_TOKEN }, 500) }],
      [
        '프로필 resultcode 실패',
        { [PROFILE_URL]: () => json({ resultcode: '024', message: ACCESS_TOKEN }) },
      ],
      ['프로필에 id 없음', { [PROFILE_URL]: () => json({ resultcode: '00', t: ACCESS_TOKEN }) }],
      [
        '네트워크 오류',
        {
          [TOKEN_URL]: () => {
            throw new TypeError(`fetch failed ${CODE} ${CONFIG.clientSecret}`);
          },
        },
      ],
    ])('%s일 때 오류 문구에 코드 · 토큰 · 시크릿 · state가 없다', async (_reason, override) => {
      stubFetch({ ...normal(), ...override });

      const error = await failure(client().fetchProfile(CODE, CONTEXT));

      for (const secret of secrets) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    });

    it('오류 문구에는 오류 식별자만 남는다 (error_description은 남기지 않는다)', async () => {
      stubFetch({
        ...normal(),
        [TOKEN_URL]: () =>
          json({ error: 'invalid_request', error_description: 'authorization code not found' }),
      });

      const error = await failure(client().fetchProfile(CODE, CONTEXT));

      expect(error.message).toContain('invalid_request');
      expect(error.message).not.toContain('authorization code not found');
    });
  });
});
