import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { dropCache, restoreCache, saveCache, useOfflineCache } from '../lib/offline-cache';
import { api } from '../lib/api';
import { useAuth } from '../stores/auth';

const mockFiles = new Map<string, string>();
jest.mock('../lib/local/storage', () => ({
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => mockFiles.set(n, JSON.stringify(d)),
  dropDb: (n: string) => mockFiles.delete(n),
  keepFile: (uri: string) => ({ uri, size: 0 }),
}));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
beforeEach(() => {
  mockFiles.clear();
  jest.restoreAllMocks();
});

it('받아 둔 조회를 적어 두고, 같은 계정이면 다시 켤 때 채운다', () => {
  const a = client();
  a.setQueryData(['folders'], [{ _id: 'f1' }]);
  saveCache(a, 'u1');
  const b = client();
  restoreCache(b, 'u1');
  expect(b.getQueryData(['folders'])).toEqual([{ _id: 'f1' }]);
  // 다른 계정 · 일주일 넘은 캐시는 쓰지 않는다
  const c = client();
  restoreCache(c, 'u2');
  expect(c.getQueryData(['folders'])).toBeUndefined();
  const d = client();
  restoreCache(d, 'u1', Date.now() + 8 * 24 * 3600_000);
  expect(d.getQueryData(['folders'])).toBeUndefined();
  dropCache();
  expect(mockFiles.size).toBe(0);
});

it('오프라인에서 다시 받다 실패해도(error) 받아 둔 데이터는 계속 남긴다', async () => {
  const a = client();
  a.setQueryData(['folders'], [{ _id: 'f1' }]);
  await a
    .fetchQuery({ queryKey: ['folders'], queryFn: () => Promise.reject(new Error('offline')) })
    .catch(() => {});
  expect(a.getQueryState(['folders'])?.status).toBe('error');
  saveCache(a, 'u1');
  const b = client();
  restoreCache(b, 'u1');
  expect(b.getQueryData(['folders'])).toEqual([{ _id: 'f1' }]);
});

it('설정을 켜면 조회가 바뀔 때 적고, 끄면 지운다', async () => {
  jest.useFakeTimers();
  try {
    useAuth.setState({ userId: 'u1' });
    const me = jest.spyOn(api.me, 'get').mockResolvedValue({
      settings: { offlineCache: true },
    } as Awaited<ReturnType<typeof api.me.get>>);
    const qc = client();
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    await renderHook(() => useOfflineCache(), { wrapper: wrap });
    await waitFor(() => expect(mockFiles.has('query-cache')).toBe(true));
    await act(async () => qc.setQueryData(['folders'], [{ _id: 'f9' }]));
    await act(async () => jest.advanceTimersByTime(3100));
    expect(JSON.stringify(mockFiles.get('query-cache'))).toContain('f9');
    // 끄면 지운다
    me.mockResolvedValue({ settings: { offlineCache: false } } as Awaited<
      ReturnType<typeof api.me.get>
    >);
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
    });
    await waitFor(() => expect(mockFiles.has('query-cache')).toBe(false));
  } finally {
    jest.useRealTimers();
  }
});
