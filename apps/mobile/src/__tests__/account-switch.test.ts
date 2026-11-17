import { QueryClient } from '@tanstack/react-query';
import { ERROR_CODES } from '@notelink/shared';
import { clearAccountState } from '../lib/account';
import { request } from '../lib/api/http';
import { useAuth } from '../stores/auth';
import { useDraft } from '../stores/draft';
import { useSession } from '../stores/session';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../lib/socket', () => ({
  ...jest.requireActual('../lib/socket'),
  disconnectSocket: jest.fn(),
}));
jest.mock('../lib/env', () => ({ env: { apiUrl: 'http://api' } }));

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

// 계정이 바뀌면 이전 계정의 기기 상태 · 늦게 온 토큰 갱신 응답을 버린다
describe('account switch', () => {
  it('로그아웃 · 계정 전환 때 측정 중인 세션과 업로드 초안을 비운다', () => {
    useSession.setState({ itemId: 'i1', sessionId: 's1', since: Date.now(), banked: 30 });
    useDraft.getState().set({ title: '이전 계정 자료' });
    const qc = new QueryClient();
    qc.setQueryData(['me'], { _id: 'u1' });
    clearAccountState(qc);
    expect(useSession.getState()).toMatchObject({ itemId: null, sessionId: null, banked: 0 });
    expect(useDraft.getState().title).toBe('');
    expect(qc.getQueryData(['me'])).toBeUndefined();
  });

  it('토큰을 갱신하는 동안 다른 계정으로 바뀌면 갱신 응답을 쓰지 않는다', async () => {
    const a = { accessToken: 'a-old', refreshToken: 'a-r' };
    const b = { accessToken: 'b', refreshToken: 'b-r' };
    useAuth.setState({ tokens: a });
    let finishRefresh!: (r: Response) => void;
    globalThis.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh'))
        return new Promise<Response>((res) => (finishRefresh = res));
      return json(401, { code: ERROR_CODES.TOKEN_EXPIRED, message: '만료' });
    }) as unknown as typeof fetch;

    const pending = request('GET', '/users/me').catch(() => 'failed');
    while (!finishRefresh) await new Promise((r) => setTimeout(r, 0));
    useAuth.setState({ tokens: b }); // 그 사이 B로 로그인
    finishRefresh(json(200, { data: { accessToken: 'a-new', refreshToken: 'a-r2' } }));
    await pending;
    expect(useAuth.getState().tokens).toBe(b);
  });
});
