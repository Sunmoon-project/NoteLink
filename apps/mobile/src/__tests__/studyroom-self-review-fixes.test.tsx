import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomListScreen, RoomScreen } from '../features/studyroom/room';
import { TimerScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { mine: jest.fn(), recommended: jest.fn(), get: jest.fn(), chatRoomId: jest.fn() },
  social: { messages: jest.fn() },
};
const mockEmit = jest.fn();
const mockConnectionListeners = new Set<(connected: boolean) => void>();
const mockParticipantState = jest.fn((_userId: string) => ({ camOn: false, micOn: false }));
const mockListeners = new Map<string, (payload: { roomId: string }) => void>();
const mockOutbox = new Map<
  string,
  { clientId: string; chatRoomId: string; text: string; createdAt: string }[]
>();
jest.mock('../lib/chat-outbox', () => ({
  readChatOutbox: (user: string, room: string) => mockOutbox.get(`${user}:${room}`) ?? [],
  addChatOutbox: (
    user: string,
    room: string,
    entry: { clientId: string; chatRoomId: string; text: string; createdAt: string },
  ) => {
    const key = `${user}:${room}`;
    mockOutbox.set(key, [...(mockOutbox.get(key) ?? []), entry]);
  },
  removeChatOutbox: (user: string, room: string, id: string) => {
    const key = `${user}:${room}`;
    mockOutbox.set(
      key,
      (mockOutbox.get(key) ?? []).filter((entry) => entry.clientId !== id),
    );
  },
}));
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/upload', () => ({ uploadToBlob: jest.fn() }));
jest.mock('../lib/livekit', () => ({
  useLiveRoom: () => ({
    connected: false,
    micOn: false,
    camOn: false,
    hearing: false,
    error: null,
    participantState: (...args: [string]) => mockParticipantState(...args),
    video: () => null,
    toggleMic: jest.fn(),
    toggleCam: jest.fn(),
    toggleHearing: jest.fn(),
  }),
}));
jest.mock('../lib/socket', () => ({
  socket: {
    emit: (...args: unknown[]) => mockEmit(...args),
    onConnection: (handler: (connected: boolean) => void) => {
      mockConnectionListeners.add(handler);
      handler(true);
      return () => mockConnectionListeners.delete(handler);
    },
    on: (event: string, handler: (payload: { roomId: string }) => void) => {
      mockListeners.set(event, handler);
      return () => mockListeners.delete(event);
    },
  },
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
  mockParticipantState.mockReturnValue({ camOn: false, micOn: false });
  mockListeners.clear();
  mockConnectionListeners.clear();
  mockOutbox.clear();
  useAuth.setState({ userId: 'me' });
  useNet.setState({ state: 'ok' });
  setParams({ id: 'r1' });
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.chatRoomId.mockResolvedValue('c1');
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.rooms.recommended.mockResolvedValue([]);
  mockEmit.mockImplementation((event, _payload, ack) => {
    if (event === 'room:join' && typeof ack === 'function') ack({ ok: true });
  });
});

it('현재 방의 참가자 변경 알림을 받으면 목록을 다시 조회한다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  const initialCalls = mockApi.rooms.get.mock.calls.length;
  const onChanged = mockListeners.get('room:members-changed');
  expect(onChanged).toBeDefined();
  await act(async () => onChanged?.({ roomId: 'other' }));
  expect(mockApi.rooms.get).toHaveBeenCalledTimes(initialCalls);
  mockApi.rooms.get.mockResolvedValue({
    ...room,
    members: [{ userId: 'other', nickname: '새 참가자', role: 'member', status: 'joined' }],
  });
  await act(async () => onChanged?.({ roomId: 'r1' }));
  expect(await screen.findByText('새 참가자')).toBeTruthy();
  expect(mockApi.rooms.get.mock.calls.length).toBeGreaterThan(initialCalls);
});

it('다른 참가자의 마이크 표시는 방 정보가 아니라 라이브 연결 상태를 따른다', async () => {
  mockApi.rooms.get.mockResolvedValue({
    ...room,
    members: [{ userId: 'friend', nickname: '친구', camOn: false, micOn: true }],
  });
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByLabelText('친구 마이크 꺼짐')).toBeTruthy();
});

it('소켓이 다시 연결되면 방을 재구독하고 대기 메시지를 전송한다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  await act(async () => mockConnectionListeners.forEach((listener) => listener(false)));
  await act(async () => useNet.getState().set('ok'));
  expect(screen.getByText('● 연결이 끊겼어요 · 다시 연결 중…')).toBeTruthy();
  await sendMessage('연결 복구 테스트');
  expect(mockEmit.mock.calls.filter(([event]) => event === 'chat:send')).toHaveLength(0);
  const joins = mockEmit.mock.calls.filter(([event]) => event === 'room:join').length;
  await act(async () => mockConnectionListeners.forEach((listener) => listener(true)));
  expect(mockEmit.mock.calls.filter(([event]) => event === 'room:join').length).toBeGreaterThan(
    joins,
  );
  expect(mockEmit.mock.calls.filter(([event]) => event === 'chat:send')).toHaveLength(1);
});
afterEach(() => jest.useRealTimers());

const sendMessage = async (text: string) => {
  await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
  await fireEvent.changeText(screen.getByPlaceholderText('채팅을 입력해 주세요'), text);
  await fireEvent.press(screen.getByLabelText('전송'));
};

it('채팅 입장 실패 후 같은 화면에서 재시도해 대기 메시지를 전송한다', async () => {
  let allowJoin = false;
  mockEmit.mockImplementation((event, _payload, ack) => {
    if (event === 'room:join' && typeof ack === 'function') ack({ ok: allowJoin });
  });
  await renderScreen(<RoomScreen />, client());
  const retryLabel = '채팅 연결에 실패했어요 · 다시 연결';
  await screen.findByText(retryLabel);
  await sendMessage('대기 메시지');
  expect(mockEmit.mock.calls.filter(([event]) => event === 'chat:send')).toHaveLength(0);
  await fireEvent.press(screen.getByText(retryLabel));
  expect(await screen.findByText(retryLabel)).toBeTruthy();
  allowJoin = true;
  await fireEvent.press(screen.getByText(retryLabel));
  await waitFor(() => expect(screen.queryByText(retryLabel)).toBeNull());
  expect(mockEmit.mock.calls.filter(([event]) => event === 'chat:send')).toHaveLength(1);
});

it('2,000자 메시지는 저장하고 전송한다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  const text = '가'.repeat(2000);
  await sendMessage(text);
  expect(mockOutbox.get('me:r1')?.[0]?.text).toBe(text);
  expect(mockEmit.mock.calls.find(([event]) => event === 'chat:send')?.[1].text).toBe(text);
});

it('2,001자 메시지는 입력을 유지하고 저장하거나 전송하지 않는다', async () => {
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('방');
  const text = '가'.repeat(2001);
  await sendMessage(text);
  expect(screen.getByPlaceholderText('채팅을 입력해 주세요').props.value).toBe(text);
  expect(mockOutbox.size).toBe(0);
  expect(mockEmit.mock.calls.filter(([event]) => event === 'chat:send')).toHaveLength(0);
  expect(useToast.getState().msg).toBe('메시지는 2,000자까지 보낼 수 있어요');
});

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
  expect(screen.getByText('전송 중')).toBeTruthy();
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
  expect(screen.queryByText('전송 중')).toBeNull();
  expect(mockOutbox.get('me:r1')).toEqual([]);
});

it('화면을 다시 열면 저장된 대기 메시지를 같은 ID로 다시 전송한다', async () => {
  const firstClient = client();
  firstClient.setQueryData(['room-chat', 'r1'], 'c1');
  const first = await renderScreen(<RoomScreen />, firstClient);
  await screen.findByText('방');
  await act(async () => {});
  await sendMessage('이어 보낼 메시지');
  expect(mockOutbox.size).toBe(1);
  const firstPayload = mockEmit.mock.calls.find(([event]) => event === 'chat:send')?.[1];
  await act(async () => {
    first.unmount();
  });
  mockEmit.mockClear();
  const secondClient = client();
  secondClient.setQueryData(['room-chat', 'r1'], 'c1');
  await renderScreen(<RoomScreen />, secondClient);
  await screen.findByText('방');
  await fireEvent(screen.getByPlaceholderText('채팅을 입력해 주세요'), 'focus');
  await screen.findByText('이어 보낼 메시지');
  const retried = mockEmit.mock.calls.find(([event]) => event === 'chat:send')?.[1];
  expect(retried).toEqual(firstPayload);
});

it('방 연결 후 50개가 넘는 이전 메시지를 페이지별로 모두 읽는다', async () => {
  const items = Array.from({ length: 125 }, (_, i) => ({
    _id: String(i),
    chatRoomId: 'c1',
    senderId: 'friend',
    type: 'text',
    text: `기록 ${i}`,
    sharedItemId: null,
    createdAt: new Date(1700000000000 + i * 1000).toISOString(),
  }));
  mockApi.social.messages.mockImplementation(async (_id: string, before?: string) => {
    const end = before === undefined ? items.length : Number(before);
    return items.slice(Math.max(0, end - 50), end);
  });
  const qc = client();
  await renderScreen(<RoomScreen />, qc);
  await waitFor(() => expect(qc.getQueryData<unknown[]>(['messages', 'c1'])).toHaveLength(125));
  expect(mockApi.social.messages.mock.calls.map((call) => call[1])).toEqual([
    undefined,
    '75',
    '25',
  ]);
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
