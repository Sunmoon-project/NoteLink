import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KAKAO_CALLBACK_PATH, type KakaoConfig } from '../src/config/kakao.config.js';
import { KakaoOAuthClient } from '../src/modules/auth/social-login/kakao-oauth.client.js';
import { SocialProviderError } from '../src/modules/auth/social-login/social-provider.js';

const CONFIG: KakaoConfig = {
  restApiKey: 'test-rest-api-key',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${KAKAO_CALLBACK_PATH}`,
};

const CODE = 'kakao-one-time-code-do-not-leak';
const ACCESS_TOKEN = 'kakao-access-token-do-not-leak';

const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const USER_ME_URL = 'https://kapi.kakao.com/v2/user/me';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** 카카오 사용자 정보 조회 응답(이메일 동의 + 인증 완료) */
const USER_ME = {
  id: 3_912_345_678,
  connected_at: '2026-01-01T00:00:00Z',
  kakao_account: {
    profile_nickname_needs_agreement: false,
    profile: { nickname: '김노트' },
    has_email: true,
    email_needs_agreement: false,
    is_email_valid: true,
    is_email_verified: true,
    email: 'Student@Example.com',
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
  [TOKEN_URL]: () => json({ token_type: 'bearer', access_token: ACCESS_TOKEN, expires_in: 21599 }),
  [USER_ME_URL]: () => json(USER_ME),
});

/** 정상 응답에서 kakao_account 일부만 바꾼다 */
const withAccount = (change: Record<string, unknown>) => () =>
  json({ ...USER_ME, kakao_account: { ...USER_ME.kakao_account, ...change } });

function client() {
  return new KakaoOAuthClient(CONFIG);
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

describe('KakaoOAuthClient', () => {
  it('제공자 이름은 kakao이다', () => {
    expect(client().name).toBe('kakao');
  });

  it('로그인 주소는 카카오 인가 주소이고 state를 담는다', () => {
    const url = new URL(client().buildAuthUrl('state-abc'));

    expect(url.origin + url.pathname).toBe('https://kauth.kakao.com/oauth/authorize');
    expect(url.searchParams.get('state')).toBe('state-abc');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.restApiKey);
  });
});

describe('KakaoOAuthClient.fetchProfile', () => {
  describe('코드 교환 요청', () => {
    it('카카오 토큰 주소에 form 본문으로 POST한다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      expect(calls[0]!.url).toBe(TOKEN_URL);
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[0]!.init.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      });
    });

    it('grant_type · client_id(REST API 키) · client_secret · redirect_uri · code를 보낸다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      expect(Object.fromEntries(calls[0]!.init.body as URLSearchParams)).toEqual({
        grant_type: 'authorization_code',
        client_id: CONFIG.restApiKey,
        client_secret: CONFIG.clientSecret,
        redirect_uri: CONFIG.redirectUri,
        code: CODE,
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

    it('시간 제한(signal)을 걸고, 리다이렉트는 따라가지 않는다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      for (const call of calls) {
        expect(call.init.signal).toBeInstanceOf(AbortSignal);
        expect(call.init.redirect).toBe('error');
      }
    });
  });

  describe('사용자 정보 요청', () => {
    it('받은 access_token을 Bearer로 붙여 user/me를 GET한다', async () => {
      const calls = stubFetch(normal());

      await client().fetchProfile(CODE);

      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toBe(USER_ME_URL);
      expect(calls[1]!.init.method).toBeUndefined();
      expect(calls[1]!.init.headers).toMatchObject({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    });

    it('코드 교환이 실패하면 user/me는 부르지 않는다', async () => {
      const calls = stubFetch({
        ...normal(),
        [TOKEN_URL]: () => json({ error: 'invalid_grant' }, 400),
      });

      await failure(client().fetchProfile(CODE));

      expect(calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    });
  });

  describe('정상 응답', () => {
    it('회원번호 · 이메일 · 닉네임을 돌려준다', async () => {
      stubFetch(normal());

      await expect(client().fetchProfile(CODE)).resolves.toEqual({
        providerUid: '3912345678',
        email: 'student@example.com',
        name: '김노트',
      });
    });

    it('회원번호는 문자열로 돌려준다 (DB의 providerUid는 문자열이다)', async () => {
      stubFetch(normal());

      expect(typeof (await client().fetchProfile(CODE)).providerUid).toBe('string');
    });

    it('이메일은 소문자 · 앞뒤 공백 제거로 맞춘다 (users.email 규칙)', async () => {
      stubFetch({ ...normal(), [USER_ME_URL]: withAccount({ email: '  Student@Example.COM \n' }) });

      expect((await client().fetchProfile(CODE)).email).toBe('student@example.com');
    });

    it('닉네임의 앞뒤 공백을 지운다', async () => {
      stubFetch({ ...normal(), [USER_ME_URL]: withAccount({ profile: { nickname: ' 김노트 ' } }) });

      expect((await client().fetchProfile(CODE)).name).toBe('김노트');
    });

    it.each([
      ['profile이 없음', undefined],
      ['profile이 객체가 아님', 'x'],
      ['닉네임이 없음', {}],
      ['닉네임이 빈 문자열', { nickname: '' }],
      ['닉네임이 공백뿐', { nickname: '   ' }],
      ['닉네임이 문자열이 아님', { nickname: 7 }],
    ])('%s이면 name은 null이다', async (_reason, profile) => {
      stubFetch({ ...normal(), [USER_ME_URL]: withAccount({ profile }) });

      expect((await client().fetchProfile(CODE)).name).toBeNull();
    });

    it('응답의 다른 값(프로필 사진 · connected_at 등)은 결과에 넣지 않는다', async () => {
      stubFetch(normal());

      expect(Object.keys(await client().fetchProfile(CODE)).sort()).toEqual([
        'email',
        'name',
        'providerUid',
      ]);
    });

    it('kakao_account 전체가 없어도 로그인은 된다 (이메일 · 닉네임 없음)', async () => {
      stubFetch({ ...normal(), [USER_ME_URL]: () => json({ id: 42 }) });

      await expect(client().fetchProfile(CODE)).resolves.toEqual({
        providerUid: '42',
        email: null,
        name: null,
      });
    });

    it.each([
      ['null', null],
      ['문자열', 'x'],
      ['배열', [1]],
    ])('kakao_account가 %s이어도 로그인은 되고 이메일 · 닉네임은 null이다', async (_r, account) => {
      stubFetch({ ...normal(), [USER_ME_URL]: () => json({ id: 42, kakao_account: account }) });

      await expect(client().fetchProfile(CODE)).resolves.toEqual({
        providerUid: '42',
        email: null,
        name: null,
      });
    });
  });

  describe('이메일 인증 여부 (이메일이 겹칠 때 계정을 막는 기준이 된다)', () => {
    it.each([
      ['is_email_verified가 false', { is_email_verified: false }],
      ['is_email_verified가 없음', { is_email_verified: undefined }],
      ['is_email_verified가 문자열 "true"', { is_email_verified: 'true' }],
      ['is_email_verified가 숫자 1', { is_email_verified: 1 }],
      ['is_email_valid가 false (탈퇴 · 변경 등으로 유효하지 않음)', { is_email_valid: false }],
      ['is_email_valid가 없음', { is_email_valid: undefined }],
      ['is_email_valid가 문자열 "true"', { is_email_valid: 'true' }],
      ['둘 다 false', { is_email_valid: false, is_email_verified: false }],
    ])('%s이면 이메일을 버리고 null로 돌려준다', async (_reason, change) => {
      stubFetch({ ...normal(), [USER_ME_URL]: withAccount(change) });

      const profile = await client().fetchProfile(CODE);

      expect(profile.email).toBeNull();
      expect(profile.providerUid).toBe('3912345678'); // 로그인 자체는 된다
    });

    it.each([
      ['이메일 동의 안 함(email 필드 없음)', { email: undefined, email_needs_agreement: true }],
      ['이메일이 빈 문자열', { email: '' }],
      ['이메일이 공백뿐', { email: '   ' }],
      ['이메일이 문자열이 아님', { email: { a: 1 } }],
    ])('인증 플래그가 참이어도 %s이면 null이다', async (_reason, change) => {
      stubFetch({ ...normal(), [USER_ME_URL]: withAccount(change) });

      expect((await client().fetchProfile(CODE)).email).toBeNull();
    });
  });

  describe('회원번호(id) 검증', () => {
    it.each([
      ['없음', undefined],
      ['문자열', '3912345678'],
      ['0', 0],
      ['음수', -5],
      ['소수', 1.5],
      ['안전한 정수 범위를 넘음(정밀도 손실)', 2 ** 53],
      ['null', null],
    ])('id가 %s이면 unavailable이다 (사용자를 구분할 수 없다)', async (_reason, id) => {
      stubFetch({ ...normal(), [USER_ME_URL]: () => json({ ...USER_ME, id }) });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it('id의 최댓값 근처(안전한 정수)는 그대로 쓴다', async () => {
      stubFetch({ ...normal(), [USER_ME_URL]: () => json({ ...USER_ME, id: 2 ** 53 - 1 }) });

      expect((await client().fetchProfile(CODE)).providerUid).toBe(String(2 ** 53 - 1));
    });
  });

  describe('코드가 잘못된 경우 (invalid_code)', () => {
    it('코드 교환이 400이면 invalid_code이다 (코드 재사용 · 만료: KOE320)', async () => {
      stubFetch({
        ...normal(),
        [TOKEN_URL]: () => json({ error: 'invalid_grant', error_code: 'KOE320' }, 400),
      });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('invalid_code');
    });

    it('코드가 빈 문자열이면 카카오에 묻지 않고 invalid_code이다', async () => {
      const calls = stubFetch(normal());

      const error = await failure(client().fetchProfile(''));

      expect(error.reason).toBe('invalid_code');
      expect(calls).toHaveLength(0);
    });
  });

  describe('카카오 · 네트워크 · 설정 문제 (unavailable)', () => {
    it.each([
      ['401 invalid_client (우리 키 · 시크릿이 틀림)', 401],
      ['403', 403],
      ['429', 429],
      ['500', 500],
      ['503', 503],
    ])('코드 교환이 %s이면 unavailable이다', async (_reason, status) => {
      stubFetch({ ...normal(), [TOKEN_URL]: () => json({ error: 'x' }, status) });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });

    it.each([400, 401, 500])('user/me가 %i이면 unavailable이다', async (status) => {
      stubFetch({ ...normal(), [USER_ME_URL]: () => json({ msg: 'x', code: -401 }, status) });

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

    it('시간 제한에 걸려도(TimeoutError) unavailable이다', async () => {
      stubFetch({
        ...normal(),
        [USER_ME_URL]: () => {
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
    ])('user/me 응답이 %s이면 unavailable이다', async (_reason, respond) => {
      stubFetch({ ...normal(), [USER_ME_URL]: respond });

      expect((await failure(client().fetchProfile(CODE))).reason).toBe('unavailable');
    });
  });

  describe('오류 원인을 로그에서 알 수 있다 (비밀값은 제외)', () => {
    it('카카오 오류 번호와 설명(msg)을 오류 문구에 남긴다 (IP 제한 같은 콘솔 설정 문제를 바로 알 수 있다)', async () => {
      stubFetch({
        ...normal(),
        [USER_ME_URL]: () =>
          json(
            { msg: 'ip mismatched! callerIp=1.2.3.4. check out registered ips.', code: -401 },
            401,
          ),
      });

      const error = await failure(client().fetchProfile(CODE));

      expect(error.message).toContain('401');
      expect(error.message).toContain('-401');
      expect(error.message).toContain('ip mismatched! callerIp=1.2.3.4');
    });

    it('토큰 · 코드 모양의 긴 문자열이 든 msg는 남기지 않는다', async () => {
      stubFetch({
        ...normal(),
        [TOKEN_URL]: () =>
          json(
            {
              error: 'invalid_grant',
              error_code: 'KOE320',
              msg: `code not found for code=${'a'.repeat(60)}`,
            },
            400,
          ),
      });

      const error = await failure(client().fetchProfile(CODE));

      expect(error.message).toContain('KOE320');
      expect(error.message).not.toContain('aaaaaaaaaa');
      expect(error.message).not.toContain('code not found');
    });

    it('너무 긴 msg는 남기지 않는다', async () => {
      stubFetch({
        ...normal(),
        [USER_ME_URL]: () => json({ msg: 'x '.repeat(100), code: -2 }, 400),
      });

      const error = await failure(client().fetchProfile(CODE));

      expect(error.message).toContain('-2');
      expect(error.message).not.toContain('x x x');
    });

    it('문자열이 아닌 msg와 식별자 모양이 아닌 error는 무시한다', async () => {
      stubFetch({
        ...normal(),
        [USER_ME_URL]: () =>
          json({ msg: { a: 1 }, error: 'has space and (symbols)', code: 'str' }, 500),
      });

      const error = await failure(client().fetchProfile(CODE));

      expect(error.message).toBe('카카오 사용자 정보 조회 응답 상태: 500');
    });
  });

  describe('오류에 비밀값을 남기지 않는다', () => {
    const secrets = [CODE, ACCESS_TOKEN, CONFIG.clientSecret];

    it.each([
      ['코드 교환 400', { [TOKEN_URL]: () => json({ error: 'invalid_grant', code: CODE }, 400) }],
      ['코드 교환 500', { [TOKEN_URL]: () => json({ secret: CONFIG.clientSecret }, 500) }],
      ['코드 교환 응답이 이상함', { [TOKEN_URL]: () => json({ access_token: 123, v: CODE }) }],
      ['user/me 500', { [USER_ME_URL]: () => json({ t: ACCESS_TOKEN }, 500) }],
      ['user/me에 id 없음', { [USER_ME_URL]: () => json({ t: ACCESS_TOKEN }) }],
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
