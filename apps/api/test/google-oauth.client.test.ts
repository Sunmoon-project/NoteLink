import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GOOGLE_CALLBACK_PATH, type GoogleConfig } from '../src/config/google.config.js';
import { GoogleOAuthClient } from '../src/modules/auth/social-login/google-oauth.client.js';
import { SocialProviderError } from '../src/modules/auth/social-login/social-provider.js';

const CONFIG: GoogleConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${GOOGLE_CALLBACK_PATH}`,
};

const CODE = 'google-one-time-code-do-not-leak';
const ACCESS_TOKEN = 'google-access-token-do-not-leak';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const USERINFO = {
  sub: '110169484474386276334',
  email: 'Student@Example.com',
  email_verified: true,
  name: '김노트',
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
  [TOKEN_URL]: () => json({ access_token: ACCESS_TOKEN, id_token: 'ignored', expires_in: 3599 }),
  [USERINFO_URL]: () => json(USERINFO),
});

function client() {
  return new GoogleOAuthClient(CONFIG);
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

describe('GoogleOAuthClient.fetchProfile', () => {
  describe('코드 교환 요청', () => {
    it('구글 토큰 주소에 POST로 보낸다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      expect(calls[0]!.url).toBe(TOKEN_URL);
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[0]!.init.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
    });

    it('코드 · client_id · client_secret · redirect_uri · grant_type을 본문(form)으로 보낸다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      const body = calls[0]!.init.body as URLSearchParams;
      expect(Object.fromEntries(body)).toEqual({
        code: CODE,
        client_id: CONFIG.clientId,
        client_secret: CONFIG.clientSecret,
        redirect_uri: CONFIG.redirectUri,
        grant_type: 'authorization_code',
      });
    });

    it('비밀값을 주소(쿼리)에 싣지 않는다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      for (const call of calls) {
        expect(call.url).not.toContain(CONFIG.clientSecret);
        expect(call.url).not.toContain(CODE);
        expect(call.url).not.toContain('?');
      }
    });

    it('시간 제한(signal)을 걸고, 리디렉션은 따라가지 않는다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      for (const call of calls) {
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
        expect(call.init.redirect).toBe('error');
      }
    });
  });

  describe('사용자 정보 요청', () => {
    it('받은 access_token을 Bearer로 붙여 userinfo를 GET한다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toBe(USERINFO_URL);
      expect(calls[1]!.init.method).toBeUndefined();
      expect(calls[1]!.init.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    });

    it('코드 교환이 실패하면 userinfo는 부르지 않는다', async () => {
      const calls = stubFetch({
        ...normal(),
        [TOKEN_URL]: () => json({ error: 'invalid_grant' }, 400),
      });

      await failure(client().fetchProfile(CODE));

      expect(calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    });
  });

  describe('정상 응답', () => {
    it('구글 고유 번호 · 이메일 · 이름을 돌려준다', async () => {
      stubFetch(normal());

      await expect(client().fetchProfile(CODE)).resolves.toEqual({
        providerUid: '110169484474386276334',
        email: 'student@example.com',
        name: '김노트',
      });
    });

    it('이메일은 소문자 · 앞뒤 공백 제거로 맞춘다 (users.email 규칙)', async () => {
      stubFetch({
        ...normal(),
        [USERINFO_URL]: () => json({ ...USERINFO, email: '  Student@Example.COM \n' }),
      });

      const profile = await client().fetchProfile(CODE);

      expect(profile.email).toBe('student@example.com');
    });

    it('이름의 앞뒤 공백을 지운다', async () => {
      stubFetch({ ...normal(), [USERINFO_URL]: () => json({ ...USERINFO, name: '  김노트  ' }) });

      expect((await client().fetchProfile(CODE)).name).toBe('김노트');
    });

    it.each([
      ['이름이 없음', undefined],
      ['이름이 빈 문자열', ''],
      ['이름이 공백뿐', '   '],
      ['이름이 문자열이 아님', 123],
    ])('%s이면 name은 null이다', async (_reason, name) => {
      stubFetch({ ...normal(), [USERINFO_URL]: () => json({ ...USERINFO, name }) });

      expect((await client().fetchProfile(CODE)).name).toBeNull();
    });

    it('응답의 id_token 등 다른 값은 결과에 넣지 않는다', async () => {
      stubFetch({
        ...normal(),
        [USERINFO_URL]: () => json({ ...USERINFO, picture: 'https://x', locale: 'ko' }),
      });

      expect(Object.keys(await client().fetchProfile(CODE)).sort()).toEqual([
        'email',
        'name',
        'providerUid',
      ]);
    });
  });

  describe('이메일 인증 여부 (이메일이 겹칠 때 계정을 막는 기준이 된다)', () => {
    it.each([
      ['email_verified가 false', { email_verified: false }],
      ['email_verified가 없음', { email_verified: undefined }],
      ['email_verified가 문자열 "true"', { email_verified: 'true' }],
      ['email_verified가 숫자 1', { email_verified: 1 }],
    ])('%s이면 이메일을 버리고 null로 돌려준다', async (_reason, change) => {
      stubFetch({ ...normal(), [USERINFO_URL]: () => json({ ...USERINFO, ...change }) });

      const profile = await client().fetchProfile(CODE);

      expect(profile.email).toBeNull();
      expect(profile.providerUid).toBe(USERINFO.sub); // 로그인 자체는 된다
    });

    it.each([
      ['이메일이 없음', undefined],
      ['이메일이 빈 문자열', ''],
      ['이메일이 문자열이 아님', { a: 1 }],
    ])('인증됐어도 %s이면 null이다', async (_reason, email) => {
      stubFetch({ ...normal(), [USERINFO_URL]: () => json({ ...USERINFO, email }) });

      expect((await client().fetchProfile(CODE)).email).toBeNull();
    });
  });

  describe('코드가 잘못된 경우 (invalid_code)', () => {
    it('코드 교환이 400이면 invalid_code이다 (코드 재사용 · 만료)', async () => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json({ error: 'invalid_grant' }, 400) });

      const error = await failure(client().fetchProfile(CODE));

      expect(error.reason).toBe('invalid_code');
    });

    it('코드가 빈 문자열이면 구글에 묻지 않고 invalid_code이다', async () => {
      const calls = stubFetch(normal());

      const error = await failure(client().fetchProfile(''));

      expect(error.reason).toBe('invalid_code');
      expect(calls).toHaveLength(0);
    });
  });

  describe('구글 · 네트워크 · 설정 문제 (unavailable)', () => {
    it.each([
      ['401 invalid_client (우리 client_id · secret이 틀림)', 401],
      ['403', 403],
      ['429', 429],
      ['500', 500],
      ['503', 503],
    ])('코드 교환이 %s이면 unavailable이다', async (_reason, status) => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json({ error: 'x' }, status) });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it.each([400, 401, 500])('userinfo가 %i이면 unavailable이다', async (status) => {
      stubFetch({ ...normal(), [USERINFO_URL]: () => json({ error: 'x' }, status) });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it('네트워크가 끊기면(fetch가 거부됨) unavailable이다', async () => {
      stubFetch({
        ...normal(),
        [TOKEN_URL]: () => {
          throw new TypeError('fetch failed');
        },
      });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it('시간 제한에 걸려도(AbortError) unavailable이다', async () => {
      stubFetch({
        ...normal(),
        [USERINFO_URL]: () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it.each([
      ['access_token이 없음', {}],
      ['access_token이 빈 문자열', { access_token: '' }],
      ['access_token이 문자열이 아님', { access_token: 123 }],
    ])('코드 교환 응답에서 %s이면 unavailable이다', async (_reason, body) => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json(body) });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it.each([
      ['JSON이 아님', () => new Response('<html>oops</html>', { status: 200 })],
      ['배열', () => json([1, 2, 3])],
      ['null', () => json(null)],
      ['문자열', () => json('text')],
    ])('코드 교환 응답이 %s이면 unavailable이다', async (_reason, respond) => {
      stubFetch({ ...normal(), [TOKEN_URL]: respond });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it.each([
      ['sub가 없음', { sub: undefined }],
      ['sub가 빈 문자열', { sub: '' }],
      ['sub가 공백뿐', { sub: '   ' }],
      ['sub가 숫자', { sub: 123456 }],
    ])('userinfo에서 %s이면 unavailable이다 (사용자를 구분할 수 없다)', async (_reason, change) => {
      stubFetch({ ...normal(), [USERINFO_URL]: () => json({ ...USERINFO, ...change }) });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });
  });

  describe('오류에 비밀값을 남기지 않는다', () => {
    const secrets = [CODE, ACCESS_TOKEN, CONFIG.clientSecret];

    it.each([
      ['코드 교환 400', { [TOKEN_URL]: () => json({ error: 'invalid_grant', code: CODE }, 400) }],
      ['코드 교환 500', { [TOKEN_URL]: () => json({ secret: CONFIG.clientSecret }, 500) }],
      ['코드 교환 응답이 이상함', { [TOKEN_URL]: () => json({ access_token: 123, v: CODE }) }],
      ['userinfo 500', { [USERINFO_URL]: () => json({ t: ACCESS_TOKEN }, 500) }],
      ['userinfo에 sub 없음', { [USERINFO_URL]: () => json({ t: ACCESS_TOKEN }) }],
      [
        '네트워크 오류',
        {
          [TOKEN_URL]: () => {
            throw new TypeError(`fetch failed ${CODE} ${CONFIG.clientSecret}`);
          },
        },
      ],
    ])('%s일 때 오류 문구에 코드 · 토큰 · 시크릿이 없다', async (_reason, override) => {
      stubFetch({ ...normal(), ...override });

      const error = await failure(client().fetchProfile(CODE));

      for (const secret of secrets) {
        expect(error.message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    });
  });
});
