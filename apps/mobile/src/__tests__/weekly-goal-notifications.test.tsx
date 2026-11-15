import { Alert } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { WeeklyGoalNotifications } from '../features/session/weekly-goal-notifications';
import { useAuth } from '../stores/auth';
import { useSession } from '../stores/session';

const mockStore = new Map<string, string>();
const mockSchedule = jest.fn(async (_request: unknown) => 'reservation');
const mockCancel = jest.fn(async (_id: string) => {});
const mockAck = jest.fn(async (_week: string) => {});
let mockResponse: ((event: unknown) => void) | undefined;
const mockGoal = {
  _id: 'goal',
  weekStart: '2026-11-09',
  targetMin: 60,
  notify80: true,
  notified80: false,
  recentAvgMin: 0,
};
jest.mock('../lib/api', () => ({
  api: {
    study: {
      weeklyGoal: async () => mockGoal,
      weekly: async () => ({ weekStart: '2026-11-09', totalSec: 0 }),
      acknowledgeWeeklyGoal: (week: string) => mockAck(week),
    },
  },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));
jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DATE: 'date' },
  getPermissionsAsync: jest.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: (request: unknown) => mockSchedule(request),
  cancelScheduledNotificationAsync: (id: string) => mockCancel(id),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  clearLastNotificationResponseAsync: jest.fn(async () => {}),
  addNotificationResponseReceivedListener: (fn: (event: unknown) => void) => {
    mockResponse = fn;
    return {
      remove: () => {
        mockResponse = undefined;
      },
    };
  },
}));
jest.mock('expo-haptics', () => ({}));

const now = Date.parse('2026-11-09T03:00:00Z');
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(now);
  mockStore.clear();
  mockSchedule.mockClear();
  mockCancel.mockClear();
  mockAck.mockClear();
  useAuth.setState({ userId: 'user', tokens: { accessToken: 'token', refreshToken: 'refresh' } });
  useSession.setState({
    itemId: 'item',
    sessionId: 'session',
    since: now,
    segments: [],
    pausedAt: null,
  });
});
afterEach(() => {
  useSession.getState().reset();
  jest.restoreAllMocks();
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WeeklyGoalNotifications />
    </QueryClientProvider>,
  );
}

it('공부 중 80% 도달 시각에 알림을 예약하고 일시정지하면 취소한다', async () => {
  show();
  await waitFor(() => expect(mockSchedule).toHaveBeenCalledTimes(1));
  const request = mockSchedule.mock.calls[0]![0] as unknown as { trigger: { date: Date } };
  expect(request.trigger.date.getTime()).toBe(now + 48 * 60 * 1000);
  expect(mockAck).not.toHaveBeenCalled();
  await act(async () => useSession.setState({ since: null, pausedAt: now }));
  await waitFor(() => expect(mockCancel).toHaveBeenCalledWith('reservation'));
});

it('알림을 열어도 확인 전에는 서버에 기록하지 않고 확인을 눌러야 저장한다', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  show();
  await waitFor(() => expect(mockResponse).toBeDefined());
  await act(async () =>
    mockResponse?.({
      notification: {
        request: {
          content: { data: { kind: 'weekly-goal-80', userId: 'user', weekStart: '2026-11-09' } },
        },
      },
    }),
  );
  expect(mockAck).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0]![2]!;
  await act(async () => buttons.find((button) => button.text === '확인')!.onPress!());
  expect(mockAck).toHaveBeenCalledWith('2026-11-09');
});

it('이미 발송 시각이 지난 예약은 확인 전 앱 재진입으로 다시 만들지 않는다', async () => {
  mockStore.set(
    'weekly80.user.2026-11-09',
    JSON.stringify({ id: 'previous', dueAt: now - 1000, sessionId: 'session', targetMin: 60 }),
  );
  jest.mocked(SecureStore.getItemAsync).mockClear();
  show();
  await waitFor(() =>
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith('weekly80.user.2026-11-09'),
  );
  expect(mockSchedule).not.toHaveBeenCalled();
  expect(mockAck).not.toHaveBeenCalled();
});
