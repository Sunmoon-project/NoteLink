import { act, renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { usePlayback, useResume } from '../features/content/player';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { api } from '../lib/api';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));
jest.mock('expo-audio', () => ({ useAudioPlayer: jest.fn(), useAudioPlayerStatus: jest.fn() }));
const mockToast = jest.fn();
jest.mock('../stores/toast', () => ({ toast: (m: string) => mockToast(m) }));

const meWith = (resumePlayback: boolean) =>
  jest
    .spyOn(api.me, 'get')
    .mockResolvedValue({ settings: { resumePlayback } } as Awaited<ReturnType<typeof api.me.get>>);
const wrap = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
const run = async (pos = 0) => {
  const seek = jest.fn();
  const view = await renderHook(
    ({ at }: { at: number }) => useResume('m1', { ready: true, duration: 600, pos: at, seek }),
    { wrapper: wrap, initialProps: { at: pos } },
  );
  return { seek, view };
};

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

it('이어듣기가 켜져 있으면 지난번 멈춘 자리부터 재생하고 알린다', async () => {
  meWith(true);
  mockStore.set('notelink.playpos.m1', '125');
  const { seek } = await run();
  await waitFor(() => expect(seek).toHaveBeenCalledWith(125));
  expect(mockToast).toHaveBeenCalledWith('지난번 02:05부터 이어서 들어요');
});

it('듣는 자리를 적어 두고, 끝까지 들으면 처음부터 듣게 지운다', async () => {
  meWith(true);
  const { view } = await run();
  await waitFor(() => expect(api.me.get).toHaveBeenCalled());
  // 지난 자리 읽기(비동기)가 끝나야 적기 시작한다 — 남은 프로미스를 모두 흘려보낸다
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await view.rerender({ at: 42 });
  await waitFor(() => expect(mockStore.get('notelink.playpos.m1')).toBe('42'));
  await view.rerender({ at: 598 });
  await waitFor(() => expect(mockStore.get('notelink.playpos.m1')).toBe('0'));
});

it('이어듣기가 꺼져 있으면 옮기지도 적지도 않는다', async () => {
  meWith(false);
  mockStore.set('notelink.playpos.m1', '125');
  const { seek, view } = await run();
  await waitFor(() => expect(api.me.get).toHaveBeenCalled());
  await view.rerender({ at: 300 });
  await act(async () => {});
  expect(seek).not.toHaveBeenCalled();
  expect(mockStore.get('notelink.playpos.m1')).toBe('125');
});

it('지난 자리를 읽는 동안 화면을 닫으면 아무것도 적지 않아 지난 자리를 지킨다', async () => {
  meWith(true);
  mockStore.set('notelink.playpos.m1', '125');
  const SecureStore = jest.requireMock<typeof import('expo-secure-store')>('expo-secure-store');
  let release!: (v: string | null) => void;
  jest
    .mocked(SecureStore.getItemAsync)
    .mockImplementationOnce(() => new Promise((r) => (release = r)));
  const { seek, view } = await run();
  await waitFor(() => expect(SecureStore.getItemAsync).toHaveBeenCalled());
  await view.unmount();
  await act(async () => release('125'));
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  expect(mockStore.get('notelink.playpos.m1')).toBe('125');
  // 닫힌 플레이어를 옮기거나 알리지도 않는다
  expect(seek).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});

// iOS QA(TC-NOTE-026, 2026-11-21): 녹음 파일을 불러오기 전에 지난 자리로 옮기면 iOS 플레이어가 무시해 00:00에 머물고,
// 곧이어 0초가 적혀 지난 자리마저 지워졌다 → 파일을 다 불러온(ready) 뒤에 옮긴다
it('녹음 파일을 다 불러오기 전(isLoaded false)에는 재생 준비 전으로 두어 지난 자리로 옮기지 않는다', async () => {
  jest.mocked(useAudioPlayer).mockReturnValue({ loop: false } as never);
  const status = { currentTime: 0, duration: 0, playing: false, playbackRate: 1, isLoaded: false };
  jest.mocked(useAudioPlayerStatus).mockImplementation(() => status as never);
  const view = await renderHook(() => usePlayback('https://blob.example/a.m4a', 205));
  expect(view.result.current.ready).toBe(false);
  status.isLoaded = true;
  await view.rerender({});
  expect(view.result.current.ready).toBe(true);
});

it('지난 자리로 옮기는 동안(아직 0초) 0초를 적어 지난 자리를 지우지 않는다', async () => {
  meWith(true);
  mockStore.set('notelink.playpos.m1', '30');
  const { seek, view } = await run(0);
  await waitFor(() => expect(seek).toHaveBeenCalledWith(30));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  // 옮기기가 반영되기 전 상태 갱신(0초)이 한 번 더 와도 그대로
  await view.rerender({ at: 0.25 });
  await act(async () => {});
  expect(mockStore.get('notelink.playpos.m1')).toBe('30');
  await view.unmount();
  expect(mockStore.get('notelink.playpos.m1')).toBe('30');
});
