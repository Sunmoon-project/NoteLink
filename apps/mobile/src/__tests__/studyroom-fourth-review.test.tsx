import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useLiveRoom } from '../lib/livekit';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { RoomScreen } from '../features/studyroom/room';
import { TimerScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';
import { useMockFlags } from '../lib/mock/flags';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { get: jest.fn(), chatRoomId: jest.fn(), setTimer: jest.fn() },
  social: { messages: jest.fn() },
};
let mockNow = Date.parse('2026-11-02T00:00:00.000Z');
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('../lib/livekit', () => ({
  useLiveRoom: jest.fn(() => ({
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
  })),
}));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: jest.fn(() => () => {}) } }));
jest.mock('../hooks', () => ({ ...jest.requireActual('../hooks'), useNow: () => mockNow }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ UploadType: { BINARY_CONTENT: 0 }, File: jest.fn() }));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const roomId = 'timer-retry-room';
const rule = { enabled: true, type: 'pomodoro', focusMin: 25, breakMin: 5, repeat: 4, periods: [] };
const room = {
  _id: roomId,
  title: '경계 조회 재시도 방',
  hostId: 'me',
  inviteCode: 'AB1234',
  members: [],
  timerRule: rule,
  memberCount: 0,
  maxCapacity: 6,
};
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(qc);
  return qc;
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.values(mockApi.rooms).forEach((fn) => fn.mockReset());
  mockNow = Date.parse('2026-11-02T00:00:00.000Z');
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
  useAuth.setState({ userId: 'me' });
  useNet.setState({ state: 'ok' });
  useMockFlags.getState().reset();
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.chatRoomId.mockResolvedValue('retry-room-chat');
  mockApi.rooms.setTimer.mockResolvedValue(room);
  mockApi.social.messages.mockResolvedValue([]);
  setParams({ id: roomId });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('단계 경계 조회가 최종 실패해도 5초 뒤 재시도하고 응답 대기 중 조회를 쌓지 않는다', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(mockNow);
  const focusEnd = mockNow + 1000;
  const recovered = {
    ...room,
    timerState: { phase: 'break', endsAt: new Date(focusEnd + 30 * 60000).toISOString() },
  };
  let complete!: (snapshot: typeof recovered) => void;
  const pending = new Promise<typeof recovered>((resolve) => {
    complete = resolve;
  });
  mockApi.rooms.get
    .mockResolvedValueOnce({
      ...room,
      timerState: { phase: 'focus', endsAt: new Date(focusEnd).toISOString() },
    })
    .mockRejectedValueOnce(new Error('최종 조회 실패'))
    .mockReturnValue(pending);
  function ClockHarness() {
    const [tick, setTick] = useState(0);
    return (
      <View>
        <Pressable accessibilityLabel="재시도 테스트 시계" onPress={() => setTick((n) => n + 1)}>
          <Text>{tick}</Text>
        </Pressable>
        <RoomScreen />
      </View>
    );
  }
  const advance = async (ms: number) => {
    mockNow += ms;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
    await fireEvent.press(screen.getByLabelText('재시도 테스트 시계'));
  };
  const qc = client();
  await renderScreen(<ClockHarness />, qc);
  expect(await screen.findByText(/^집중 (?:00:)?00:01$/)).toBeTruthy();
  await advance(1000);
  await waitFor(() => expect(mockApi.rooms.get).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(qc.getQueryState(['room', roomId])?.status).toBe('error'));
  try {
    await advance(4999);
    expect(mockApi.rooms.get).toHaveBeenCalledTimes(2);
    await advance(1);
    await waitFor(() => expect(mockApi.rooms.get).toHaveBeenCalledTimes(3));
    await advance(10000);
    expect(mockApi.rooms.get).toHaveBeenCalledTimes(3);
    await act(async () => {
      complete(recovered);
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(await screen.findByText(/^휴식 /)).toBeTruthy();
    expect(mockApi.rooms.get).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => {
      complete(recovered);
    });
  }
});

it('사용자가 휴식 시간을 0분으로 입력하면 미리보기와 저장 요청 모두 0분을 유지한다', async () => {
  await renderScreen(<TimerScreen />, client());
  await fireEvent.changeText(await screen.findByDisplayValue('5'), '0');
  expect(screen.getByText('집중 25분 → 휴식 0분 × 4회 · 총 100분')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '저장하기' }));
  await waitFor(() =>
    expect(mockApi.rooms.setTimer).toHaveBeenCalledWith(
      roomId,
      expect.objectContaining({ focusMin: 25, breakMin: 0 }),
    ),
  );
});

it('기존 0분 휴식 설정은 수정 없이 저장해도 10분으로 바뀌지 않는다', async () => {
  mockApi.rooms.get.mockResolvedValue({ ...room, timerRule: { ...rule, breakMin: 0 } });
  await renderScreen(<TimerScreen />, client());
  await screen.findByDisplayValue('0');
  await fireEvent.press(screen.getByRole('button', { name: '저장하기' }));
  await waitFor(() =>
    expect(mockApi.rooms.setTimer).toHaveBeenCalledWith(
      roomId,
      expect.objectContaining({ breakMin: 0 }),
    ),
  );
});

it('방 최초 조회 실패는 오류·재시도를 제공하고 조회 전 미디어를 시작하지 않는다', async () => {
  mockApi.rooms.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(room);
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('스터디룸 정보를 불러오지 못했어요');
  expect(jest.mocked(useLiveRoom).mock.calls.at(-1)?.[1]).toBe(false);
  await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByText(room.title);
  expect(mockApi.rooms.get).toHaveBeenCalledTimes(2);
  expect(jest.mocked(useLiveRoom).mock.calls.at(-1)?.[1]).toBe(true);
});

it('없는 방이나 접근 거절은 무한 로딩 대신 복귀 경로를 제공한다', async () => {
  mockApi.rooms.get.mockRejectedValue(new Error('NOT_FOUND'));
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('스터디룸 정보를 불러오지 못했어요');
  await fireEvent.press(screen.getByRole('button', { name: '돌아가기' }));
  expect(router.back).toHaveBeenCalledTimes(1);
  expect(jest.mocked(useLiveRoom).mock.calls.at(-1)?.[1]).toBe(false);
});
