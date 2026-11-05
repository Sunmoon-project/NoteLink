import { getProviderToken, socialLoginReady } from '../lib/social-auth';

const mockOpen = jest.fn();
let mockRandom = 1;
jest.mock('../lib/web-browser-loader', () => ({
  loadBrowser: async () => ({ openAuthSessionAsync: (...a: unknown[]) => mockOpen(...a) }),
  loadCrypto: async () => ({
    getRandomBytes: (n: number) => Uint8Array.from({ length: n }, () => mockRandom++),
    digestStringAsync: async () => 'a+b/c==',
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { BASE64: 'base64' },
  }),
}));
jest.mock('../lib/env', () => ({ env: { useMock: false, apiUrl: 'https://api.test/api/v1' } }));

afterEach(() => mockOpen.mockReset());

it('서버가 있으면 켜진다', () => expect(socialLoginReady).toBe(true));

/** 서버처럼 시작 주소의 state를 그대로 돌려준다 */
const back = (url: string, extra = 'code=one-time') => {
  const state = new URL(url).searchParams.get('state');
  return { type: 'success', url: `notelink://auth/callback?${extra}&state=${state}` };
};

it.each(['kakao', 'naver', 'google'] as const)(
  '%s: 서버 시작 주소에 state와 PKCE를 실어 열고, 맞게 돌아오면 코드와 검증값을 준다',
  async (p) => {
    mockOpen.mockImplementation(async (url: string) => back(url));
    const r = await getProviderToken(p);
    expect(r.token).toBe('one-time');
    expect(r.codeVerifier).toMatch(/^[0-9a-f]{64}$/);
    const [url, redirect] = mockOpen.mock.calls[0]!;
    expect(redirect).toBe('notelink://auth/callback');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`https://api.test/api/v1/auth/social/${p}/start`);
    expect(u.searchParams.get('redirect')).toBe('notelink://auth/callback');
    expect(u.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(u.searchParams.get('code_challenge')).toBe('a-b_c');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  },
);

it('브라우저를 닫으면 취소로 안내한다', async () => {
  mockOpen.mockResolvedValue({ type: 'cancel' });
  await expect(getProviderToken('kakao')).rejects.toThrow('취소했어요');
});

it('코드 없이 돌아오면 실패로 알린다', async () => {
  mockOpen.mockImplementation(async (url: string) => back(url, 'error=denied'));
  await expect(getProviderToken('naver')).rejects.toThrow('마치지 못했어요');
});

it('state가 다르면 코드를 쓰지 않는다 (다른 앱 · 다른 시도의 코드)', async () => {
  mockOpen.mockResolvedValue({
    type: 'success',
    url: 'notelink://auth/callback?code=stolen&state=other',
  });
  await expect(getProviderToken('google')).rejects.toThrow('마치지 못했어요');
});

it('복귀 주소가 다르면 코드를 쓰지 않는다', async () => {
  mockOpen.mockImplementation(async (url: string) => ({
    ...back(url),
    url: back(url).url.replace('auth/callback', 'other'),
  }));
  await expect(getProviderToken('google')).rejects.toThrow('마치지 못했어요');
});
