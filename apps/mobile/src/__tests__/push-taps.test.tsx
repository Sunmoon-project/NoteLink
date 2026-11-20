// 푸시를 눌렀을 때 화면 이동 · 읽음 처리(#560). 앱이 꺼진 채 알림으로 열렸을 때도 한 번만
import { renderHook, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { usePushTaps } from '../features/notifications/push-taps';

const mockMarkRead = jest.fn(async (_id: string) => {});
jest.mock('../lib/api', () => ({
  api: { notifications: { markRead: (id: string) => mockMarkRead(id) } },
}));
let mockTap: ((r: unknown) => void) | null = null;
let mockLast: unknown = null;
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: (fn: (r: unknown) => void) => {
    mockTap = fn;
    return { remove: () => (mockTap = null) };
  },
  addNotificationReceivedListener: () => ({ remove: () => {} }),
  getLastNotificationResponseAsync: async () => mockLast,
}));

const response = (id: string, data: Record<string, unknown>) => ({
  notification: { request: { identifier: id, content: { data } } },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLast = null;
});

it('누르면 읽음 처리하고 그 화면으로 간다', async () => {
  await renderHook(() => usePushTaps(true));
  await waitFor(() => expect(mockTap).not.toBeNull());
  mockTap!(response('p1', { type: 'friend-request', notificationId: 'n1' }));
  expect(mockMarkRead).toHaveBeenCalledWith('n1');
  expect(router.push).toHaveBeenCalledWith('/requests');
});

it('알림으로 앱을 연 경우 그 알림으로 한 번만 간다(다시 그려도 반복하지 않는다)', async () => {
  mockLast = response('p2', { type: 'dday-remind' });
  const { rerender, unmount } = await renderHook(({ on }: { on: boolean }) => usePushTaps(on), {
    initialProps: { on: true },
  });
  await waitFor(() => expect(router.push).toHaveBeenCalledWith('/dday'));
  await rerender({ on: false });
  await rerender({ on: true });
  await unmount();
  await renderHook(() => usePushTaps(true));
  await new Promise((r) => setTimeout(r, 20));
  expect(router.push).toHaveBeenCalledTimes(1);
});

it('로그인 전에는 듣지 않는다', async () => {
  await renderHook(() => usePushTaps(false));
  await new Promise((r) => setTimeout(r, 20));
  expect(mockTap).toBeNull();
});
