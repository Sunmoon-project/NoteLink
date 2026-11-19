import { screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomScreen } from '../features/studyroom/room';
import { useLiveRoom } from '../lib/livekit';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { get: jest.fn(), chatRoomId: jest.fn() },
  social: { messages: jest.fn() },
};
const mockNow = Date.parse('2026-11-02T03:00:00.000Z');
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/upload', () => ({ uploadToBlob: jest.fn() }));
jest.mock('../lib/livekit', () => ({ useLiveRoom: jest.fn() }));
jest.mock('../lib/socket', () => ({
  socket: { emit: jest.fn(), on: jest.fn(() => () => {}) },
}));
jest.mock('../hooks', () => ({ ...jest.requireActual('../hooks'), useNow: () => mockNow }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ UploadType: { BINARY_CONTENT: 0 }, File: jest.fn() }));

const member = (userId: string, nickname: string) => ({
  userId,
  nickname,
  role: 'member',
  status: 'joined',
});
const room = {
  _id: 'r1',
  title: '알고리즘 스터디',
  hostId: 'me',
  inviteCode: 'AB1234',
  // 방 멤버(참여 기록)는 셋이지만 지금 접속해 있는 건 나와 앞선이뿐이다
  members: [member('me', '나'), member('early', '앞선이'), member('away', '나간이')],
  memberCount: 3,
  maxCapacity: 6,
};
const live = (over: Partial<ReturnType<typeof useLiveRoom>> = {}) =>
  ({
    connected: true,
    micOn: true,
    camOn: false,
    hearing: true,
    error: null,
    video: () => null,
    toggleMic: jest.fn(),
    toggleCam: jest.fn(),
    toggleHearing: jest.fn(),
    participantState: (id: string) =>
      id === 'early'
        ? // 1시간 전부터 방에 있었고 지금 말하는 중
          { camOn: false, micOn: true, speaking: true, present: true, joinedAt: mockNow - 3600_000 }
        : id === 'me'
          ? { camOn: false, micOn: true, speaking: false, present: true, joinedAt: mockNow }
          : { camOn: false, micOn: false, speaking: false, present: false },
    ...over,
  }) as ReturnType<typeof useLiveRoom>;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockImplementation(() => mockNow);
  useAuth.setState({ userId: 'me' });
  useNet.setState({ state: 'ok' });
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.chatRoomId.mockResolvedValue('chat-1');
  mockApi.social.messages.mockResolvedValue([]);
  setParams({ id: 'r1' });
});
afterEach(() => jest.restoreAllMocks());

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

// 사용자 보고 4: 뒤로 가서 방을 나간 사람도 계속 들어와 있는 것처럼 보였다
it('실제로 접속해 있는 사람만 타일 · 「N명 접속중」에 보인다', async () => {
  jest.mocked(useLiveRoom).mockReturnValue(live());
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText('앞선이')).toBeTruthy();
  expect(screen.queryByText('나간이')).toBeNull();
  expect(screen.getByText('2명 접속중')).toBeTruthy();
});

// 사용자 보고 3: 먼저 와 있던 사람의 타이머가 내가 들어온 때부터 같이 돌았다
it('다른 사람의 타이머는 그 사람이 들어온 때부터 센다', async () => {
  jest.mocked(useLiveRoom).mockReturnValue(live());
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText('01:00:00')).toBeTruthy();
});

// 사용자 보고 1: 말하는 사람을 알 수 없었다
it('말하는 사람 타일에 「말하는 중」 표시가 붙는다', async () => {
  jest.mocked(useLiveRoom).mockReturnValue(live());
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByLabelText('앞선이 말하는 중')).toBeTruthy();
  expect(screen.queryByLabelText('나 말하는 중')).toBeNull();
});

it('캠 · 음성 연결이 끊기면 「미디어 다시 연결」 대신 노란 「다시 연결 중」 띠를 보인다', async () => {
  jest.mocked(useLiveRoom).mockReturnValue(
    live({
      connected: false,
      reconnecting: true,
      error: '캠·음성 연결이 종료됐어요. 다시 연결해 주세요',
    }),
  );
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText('● 연결이 끊겼어요 · 다시 연결 중…')).toBeTruthy();
  expect(screen.queryByText('미디어 다시 연결')).toBeNull();
  expect(screen.queryByText(/캠·음성 연결이 종료됐어요/)).toBeNull();
  expect(screen.queryByText('다시 연결됐어요')).toBeNull();
});

it('미디어가 연결되지 않은 동안(기기 저장 모드 등)은 방 멤버를 모두 보인다', async () => {
  jest
    .mocked(useLiveRoom)
    .mockReturnValue(
      live({ connected: false, participantState: () => ({ camOn: false, micOn: false }) } as never),
    );
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText('나간이')).toBeTruthy();
  expect(screen.getByText('3명 접속중')).toBeTruthy();
});

// 강퇴 · 인증 만료처럼 다시 시도하지 않는 실패에는 「다시 연결 중」이라고 하지 않는다(code-review)
it('다시 시도하지 않는 미디어 실패에는 「다시 연결 중」 띠를 띄우지 않는다', async () => {
  jest
    .mocked(useLiveRoom)
    .mockReturnValue(
      live({ connected: false, reconnecting: false, error: '캠·음성을 연결하지 못했어요' }),
    );
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText('알고리즘 스터디')).toBeTruthy();
  expect(screen.queryByText('● 연결이 끊겼어요 · 다시 연결 중…')).toBeNull();
});
