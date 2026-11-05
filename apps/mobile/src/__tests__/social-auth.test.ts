import { getProviderToken, socialLoginReady, SocialLoginCanceled } from '../lib/social-auth';

const mockOpen = jest.fn();
jest.mock('../lib/web-browser-loader', () => ({
  loadBrowser: async () => ({ openAuthSessionAsync: (...a: unknown[]) => mockOpen(...a) }),
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'https://api.test/api/v1' } }));

afterEach(() => mockOpen.mockReset());

it('서버가 있으면 켜진다', () => expect(socialLoginReady).toBe(true));

it.each(['kakao', 'naver', 'google'] as const)(
  '%s: 서버 시작 주소를 열고 돌아온 1회용 코드를 준다 (앱에 키 없음)',
  async (p) => {
    mockOpen.mockResolvedValue({
      type: 'success',
      url: 'notelink://auth/callback?code=one-time',
    });
    await expect(getProviderToken(p)).resolves.toBe('one-time');
    expect(mockOpen).toHaveBeenCalledWith(
      `https://api.test/api/v1/auth/social/${p}/start?redirect=notelink%3A%2F%2Fauth%2Fcallback`,
      'notelink://auth/callback',
    );
  },
);

it('브라우저를 닫으면 취소로 구분한다', async () => {
  mockOpen.mockResolvedValue({ type: 'cancel' });
  await expect(getProviderToken('kakao')).rejects.toBeInstanceOf(SocialLoginCanceled);
});

it('코드 없이 돌아오면 실패로 알린다', async () => {
  mockOpen.mockResolvedValue({ type: 'success', url: 'notelink://auth/callback?error=denied' });
  await expect(getProviderToken('naver')).rejects.toThrow('마치지 못했어요');
});
