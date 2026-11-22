// PROF-007: 새 알림이 와도 홈 종 아이콘 숫자가 늦게 바뀌었다(안 읽은 수는 30초 캐시).
// 홈이 보일 때(포커스)마다 안 읽은 수를 다시 읽는다. 이미 읽는 중이면 겹쳐 보내지 않는다
import { act, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { BellButton, UNREAD_KEY } from '../features/notifications';
import { renderScreen } from '../test-utils';

// 실제 useFocusEffect처럼 마운트할 때 한 번 부르고, 시험에서 떠나고(blur) 돌아오게(focus) 한다
const mockFocus = new Set<() => (() => void) | void>();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    router: { push: jest.fn() },
    useIsFocused: () => true,
    useSegments: () => [],
    useFocusEffect: (cb: () => (() => void) | void) => {
      mockFocus.add(cb);
      useEffect(() => cb(), [cb]);
    },
  };
});
let cleanups: ((() => void) | void)[] = [];
const focus = () =>
  act(async () => {
    cleanups = [...mockFocus].map((cb) => cb());
  });
const blur = () => act(() => cleanups.forEach((f) => f?.()));

const mockApi = { notifications: { unreadCount: jest.fn(async () => 0) } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));

const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  clients.push(qc);
  return qc;
};
beforeEach(() => {
  mockFocus.clear();
  jest.clearAllMocks();
});
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

it('처음 그릴 때는 한 번만 읽고, 홈에 돌아오면 30초가 안 지났어도 다시 읽어 종 숫자를 바꾼다', async () => {
  mockApi.notifications.unreadCount.mockResolvedValueOnce(0);
  await renderScreen(<BellButton />, client());
  expect(await screen.findByLabelText('알림')).toBeTruthy();
  expect(mockApi.notifications.unreadCount).toHaveBeenCalledTimes(1);

  // 다른 화면에 간 사이 새 알림이 2개 왔다
  await blur();
  mockApi.notifications.unreadCount.mockResolvedValueOnce(2);
  await focus();
  expect(await screen.findByLabelText('알림 2개 안 읽음')).toBeTruthy();
  expect(mockApi.notifications.unreadCount).toHaveBeenCalledTimes(2);
});

it('다른 화면(알림함)이 막 읽어 둔 30초 캐시가 있어도 홈을 처음 그릴 때 다시 읽는다', async () => {
  const qc = client();
  qc.setQueryData(UNREAD_KEY, 0);
  mockApi.notifications.unreadCount.mockResolvedValueOnce(3);
  await renderScreen(<BellButton />, qc);
  expect(await screen.findByLabelText('알림 3개 안 읽음')).toBeTruthy();
  expect(mockApi.notifications.unreadCount).toHaveBeenCalledTimes(1);
});
