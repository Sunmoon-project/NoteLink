import { PATHS } from '@notelink/shared';
import { httpApi } from '../lib/api/http-api';
import { useAuth } from '../stores/auth';

jest.mock('../lib/env', () => ({ env: { useMock: false, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

it('로그아웃은 서버가 폐기할 리프레시 토큰을 본문으로 보낸다', async () => {
  useAuth.setState({ tokens: { accessToken: 'a', refreshToken: 'r1' } });
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 204 }));
  await httpApi.auth.logout();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(String(url)).toContain(PATHS.logout);
  expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'r1' });
  fetchMock.mockRestore();
});

it('로그아웃은 토큰을 갱신해 옛 토큰으로 다시 보내지 않는다', async () => {
  useAuth.setState({ tokens: { accessToken: 'a', refreshToken: 'r1' } });
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify({ code: 'AUTH_TOKEN_EXPIRED', message: '만료' }), {
        status: 401,
      }),
    );
  await expect(httpApi.auth.logout()).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockRestore();
});
