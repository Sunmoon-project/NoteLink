import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Calendar from 'expo-calendar';
import { RoomScreen } from '../features/studyroom/room';
import { ScheduleScreen } from '../features/studyroom/tools';
import { mockApi as realMockApi } from '../lib/mock/api';
import { useMockFlags } from '../lib/mock/flags';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { get: jest.fn(), chatRoomId: jest.fn(), schedule: jest.fn() },
  social: { messages: jest.fn() },
};
const mockHandlers = new Map<string, (payload: unknown) => void>();
let mockNow = Date.parse('2026-11-02T00:00:00.000Z'); // 월요일 서울 09:00
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('../lib/livekit', () => ({
  useLiveRoom: () => ({
    connected: false,
    micOn: false,
    camOn: false,
    hearing: false,
    error: null,
    video: () => null,
    toggleMic: jest.fn(),
    toggleCam: jest.fn(),
    toggleHearing: jest.fn(),
    retry: jest.fn(),
  }),
}));
jest.mock('../lib/socket', () => ({
  socket: {
    emit: jest.fn(),
    on: (event: string, handler: (payload: unknown) => void) => {
      mockHandlers.set(event, handler);
      return () => mockHandlers.delete(event);
    },
  },
  mockServer: { push: jest.fn(), onClient: undefined },
}));
jest.mock('../hooks', () => ({ ...jest.requireActual('../hooks'), useNow: () => mockNow }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ UploadType: { BINARY_CONTENT: 0 }, File: jest.fn() }));
jest.mock('expo-calendar', () => ({
  requestCalendarPermissionsAsync: jest.fn(async () => ({ granted: true })),
  createEventInCalendarAsync: jest.fn(async () => ({ action: 'saved' })),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const roomId = 'server-timer-review-room';
const rule = {
  enabled: true,
  type: 'pomodoro' as const,
  focusMin: 25,
  breakMin: 5,
  repeat: 4,
  periods: [],
};
const room = {
  _id: roomId,
  title: '현재 단계가 있는 방',
  hostId: 'me',
  inviteCode: 'AB1234',
  timerRule: rule,
  members: [],
  maxCapacity: 6,
  memberCount: 0,
  isPublic: true,
  categoryId: 'study',
};
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.values(mockApi.rooms).forEach((fn) => fn.mockReset());
  mockNow = Date.parse('2026-11-02T00:00:00.000Z');
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
  useNet.setState({ state: 'ok' });
  useAuth.setState({ userId: 'me' });
  useMockFlags.getState().reset();
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.chatRoomId.mockResolvedValue('timer-review-chat');
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.rooms.schedule.mockResolvedValue({ members: [], grid: [], startHour: 9, matches: [] });
  setParams({ id: roomId });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('늦게 입장해도 이벤트 없이 REST의 휴식 단계와 절대 종료 시각으로 남은 시간을 복원한다', async () => {
  mockApi.rooms.get.mockResolvedValue({
    ...room,
    timerState: { phase: 'break', endsAt: new Date(mockNow + 5 * 60000).toISOString() },
  });
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText(/^휴식 (?:00:)?05:00$/)).toBeTruthy();
  expect(screen.queryByText(/^집중 /)).toBeNull();
});

it('재연결 시 타이머 이벤트 없이 재조회된 서버 단계·종료 시각으로 갱신한다', async () => {
  mockApi.rooms.get
    .mockResolvedValueOnce({
      ...room,
      timerState: { phase: 'focus', endsAt: new Date(mockNow + 20 * 60000).toISOString() },
    })
    .mockResolvedValue({
      ...room,
      timerState: { phase: 'break', endsAt: new Date(mockNow + 4 * 60000).toISOString() },
    });
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await act(async () => useNet.getState().set('unstable'));
  await act(async () => useNet.getState().set('ok'));
  await waitFor(() => expect(mockApi.rooms.get.mock.calls.length).toBeGreaterThan(1));
  expect(await screen.findByText(/^휴식 (?:00:)?04:00$/)).toBeTruthy();
});

it('90분 타이머를 30분으로 잘라 표시하지 않고 시간 또는 총 분을 표시한다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await act(async () => {
    mockHandlers.get('room:timer')!({
      roomId,
      phase: 'focus',
      rule: { ...rule, focusMin: 90 },
      endsAt: new Date(mockNow + 90 * 60000).toISOString(),
    });
  });
  expect(screen.queryByText('집중 30:00')).toBeNull();
  expect(await screen.findByText(/^집중 (?:01:30:00|90:00)$/)).toBeTruthy();
});

it('실제 목업 타이머는 조회마다 시작하지 않고 절대 종료 시각과 현재 단계를 보존한다', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(mockNow);
  const response = async <T,>(promise: Promise<T>): Promise<T> => {
    await jest.advanceTimersByTimeAsync(220);
    return promise;
  };
  const created = await response(
    realMockApi.rooms.create({ title: '실제 목업 타이머', categoryName: '공부', isPublic: true }),
  );
  const configured = await response(realMockApi.rooms.setTimer(created._id, rule));
  // 연결 검사를 통과해 서버가 설정을 적용한 시점부터 타이머가 시작한다.
  const startedAt = Date.now();
  const focusEnd = new Date(startedAt + 25 * 60000).toISOString();
  expect(configured).toMatchObject({ timerState: { phase: 'focus', endsAt: focusEnd } });
  await jest.advanceTimersByTimeAsync(5 * 60000);
  const later = await response(realMockApi.rooms.get(created._id));
  expect(later).toMatchObject({ timerState: { phase: 'focus', endsAt: focusEnd } });
  await jest.advanceTimersByTimeAsync(Math.max(0, startedAt + 26 * 60000 - Date.now()));
  const onBreak = await response(realMockApi.rooms.get(created._id));
  expect(onBreak).toMatchObject({
    timerState: { phase: 'break', endsAt: new Date(startedAt + 30 * 60000).toISOString() },
  });
});

it.each([
  {
    label: '오늘의 미래 일정',
    start: '15:00',
    end: '16:00',
    expectedStart: '2026-11-02T06:00:00.000Z',
    expectedEnd: '2026-11-02T07:00:00.000Z',
  },
  {
    label: '오늘 이미 지난 일정',
    start: '08:00',
    end: '08:30',
    expectedStart: '2026-11-08T23:00:00.000Z',
    expectedEnd: '2026-11-08T23:30:00.000Z',
  },
])(
  '$label은 실제 시작 시각을 비교해 알맞은 날짜에 캘린더로 보낸다',
  async ({ start, end, expectedStart, expectedEnd }) => {
    mockApi.rooms.schedule.mockResolvedValue({
      members: [],
      grid: [],
      startHour: 9,
      matches: [{ day: '월요일', label: '월요일', start, end }],
    });
    await renderScreen(<ScheduleScreen />, client());
    await screen.findByText(room.title);
    await waitFor(() => expect(screen.getAllByText(new RegExp(start)).length).toBeGreaterThan(0));
    await fireEvent.press(screen.getByText('캘린더'));
    await waitFor(() => expect(Calendar.createEventInCalendarAsync).toHaveBeenCalledTimes(1));
    const event = jest.mocked(Calendar.createEventInCalendarAsync).mock.calls[0]![0]!;
    expect(new Date(event.startDate!).toISOString()).toBe(expectedStart);
    expect(new Date(event.endDate!).toISOString()).toBe(expectedEnd);
  },
);

it('타이머 단계 경계에서 이벤트를 놓쳐도 서버를 한 번 재조회해 다음 단계로 진행한다', async () => {
  const focusEnd = mockNow + 1000;
  const breakSnapshot = {
    ...room,
    timerState: { phase: 'break', endsAt: new Date(focusEnd + 5 * 60000).toISOString() },
  };
  let complete!: (snapshot: typeof breakSnapshot) => void;
  const refreshed = new Promise<typeof breakSnapshot>((resolve) => {
    complete = resolve;
  });
  mockApi.rooms.get
    .mockResolvedValueOnce({
      ...room,
      timerState: { phase: 'focus', endsAt: new Date(focusEnd).toISOString() },
    })
    .mockReturnValue(refreshed);
  function ClockHarness() {
    const [tick, setTick] = useState(0);
    return (
      <View>
        <Pressable accessibilityLabel="테스트 시계 갱신" onPress={() => setTick((n) => n + 1)}>
          <Text>{tick}</Text>
        </Pressable>
        <RoomScreen />
      </View>
    );
  }
  await renderScreen(<ClockHarness />, client());
  expect(await screen.findByText(/^집중 (?:00:)?00:01$/)).toBeTruthy();
  expect(mockApi.rooms.get).toHaveBeenCalledTimes(1);
  try {
    mockNow = focusEnd;
    await fireEvent.press(screen.getByLabelText('테스트 시계 갱신'));
    await waitFor(() => expect(mockApi.rooms.get).toHaveBeenCalledTimes(2));
    // 응답을 기다리는 동안 시계가 더 흘러도 같은 종료 시각의 조회를 중복 시작하지 않는다.
    mockNow = focusEnd + 1000;
    await fireEvent.press(screen.getByLabelText('테스트 시계 갱신'));
    mockNow = focusEnd + 2000;
    await fireEvent.press(screen.getByLabelText('테스트 시계 갱신'));
    expect(mockApi.rooms.get).toHaveBeenCalledTimes(2);
    await act(async () => {
      complete(breakSnapshot);
    });
    expect(await screen.findByText(/^휴식 (?:00:)?04:58$/)).toBeTruthy();
    expect(mockApi.rooms.get).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      complete(breakSnapshot);
    });
  }
});

it('지연된 REST 타이머 스냅샷은 그 사이 수신한 최신 소켓 단계와 종료 시각을 덮어쓰지 않는다', async () => {
  const stale = {
    ...room,
    timerState: { phase: 'focus', endsAt: new Date(mockNow + 25 * 60000).toISOString() },
  };
  let complete!: (snapshot: typeof stale) => void;
  const delayed = new Promise<typeof stale>((resolve) => {
    complete = resolve;
  });
  mockApi.rooms.get.mockReturnValue(delayed);
  await renderScreen(<RoomScreen />, client());
  await waitFor(() => expect(mockApi.rooms.get).toHaveBeenCalledTimes(1));
  expect(mockHandlers.has('room:timer')).toBe(true);
  await act(async () => {
    mockHandlers.get('room:timer')!({
      roomId,
      phase: 'break',
      rule,
      endsAt: new Date(mockNow + 4 * 60000).toISOString(),
    });
    complete(stale);
  });
  expect(await screen.findByText(room.title)).toBeTruthy();
  expect(await screen.findByText(/^휴식 (?:00:)?04:00$/)).toBeTruthy();
  expect(screen.queryByText(/^집중 (?:00:)?25:00$/)).toBeNull();
});
