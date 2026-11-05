import { act, fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomListScreen, RoomScreen } from '../features/studyroom/room';
import { TimerScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { mine: jest.fn(), recommended: jest.fn(), get: jest.fn(), chatRoomId: jest.fn() },
  social: { messages: jest.fn() },
};
const mockEmit = jest.fn();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('../lib/upload', () => ({ uploadToBlob: jest.fn() }));
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
  }),
}));
jest.mock('../lib/socket', () => ({
  socket: { emit: (...args: unknown[]) => mockEmit(...args), on: () => () => {} },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-calendar', () => ({}));

const room = {
  _id: 'r1',
  title: '방',
  hostId: 'me',
  inviteCode: 'ABC234',
  memberCount: 1,
  members: [],
  timerRule: {
    enabled: true,
    type: 'pomodoro',
    focusMin: 50,
    breakMin: 10,
    repeat: 7,
    periods: [],
  },
};
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  jest.clearAllMocks();
  useAuth.setState({ userId: 'me' });
  useNet.setState({ state: 'ok' });
  setParams({ id: 'r1' });
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.chatRoomId.mockResolvedValue('c1');
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.rooms.recommended.mockResolvedValue([]);
});
afterEach(() => jest.useRealTimers());

const sendMessage = async (text: string) => {
  await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
  await fireEvent.changeText(screen.getByPlaceholderText('채팅을 입력해 주세요'), text);
  await fireEvent.press(screen.getByLabelText('전송'));
};

it('목록 조회가 실패하면 없다고 안내하지 않고 다시 시도하게 한다', async () => {
  mockApi.rooms.mine.mockRejectedValue(new Error('실패'));
  await renderScreen(<RoomListScreen />, client());
  expect(await screen.findByText('참여 중인 스터디룸을 불러오지 못했어요')).toBeTruthy();
  expect(screen.queryByText('참여 중인 스터디룸이 없어요')).toBeNull();
});

it('확인 응답이 없으면 메시지를 남기고 실패를 알린 뒤 다시 보낼 수 있다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  await act(async () => {});
  jest.useFakeTimers();
  await sendMessage('안녕');
  expect(screen.getByText('안녕')).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(8000);
  });
  await fireEvent.press(screen.getByText('전송하지 못했어요 · 다시 보내기'));
  const sends = mockEmit.mock.calls.filter(([event]) => event === 'chat:send');
  expect(sends).toHaveLength(2);
  expect(sends[1]?.[1]).toEqual(sends[0]?.[1]);
  expect(screen.queryByText('전송하지 못했어요 · 다시 보내기')).toBeNull();
});

it('확인 응답을 받으면 임시 메시지를 저장본으로 바꾼다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  await act(async () => {});
  await sendMessage('안녕');
  const [, payload, ack] = mockEmit.mock.calls.find(([event]) => event === 'chat:send')!;
  await act(async () => {
    ack({
      _id: 'm1',
      chatRoomId: 'c1',
      senderId: 'me',
      type: 'text',
      text: '안녕',
      clientId: payload.clientId,
    });
  });
  expect(screen.getAllByText('안녕')).toHaveLength(1);
});

it('끊김 상태에서는 방 정보를 주기적으로 다시 읽어 복구를 확인한다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  const calls = mockApi.rooms.get.mock.calls.length;
  jest.useFakeTimers();
  await act(async () => useNet.setState({ state: 'unstable' }));
  await act(async () => {
    jest.advanceTimersByTime(15000);
  });
  expect(mockApi.rooms.get.mock.calls.length).toBeGreaterThan(calls);
});

it('타이머의 반복 횟수는 저장된 규칙 값을 표시한다', async () => {
  await renderScreen(<TimerScreen />, client());
  expect(await screen.findByText('7회 반복')).toBeTruthy();
});

it('대화 기록을 못 읽으면 빈 대화로 두지 않고 다시 시도하게 한다', async () => {
  mockApi.social.messages.mockRejectedValue(new Error('실패'));
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
  expect(await screen.findByText('대화 기록을 불러오지 못했어요')).toBeTruthy();
});
