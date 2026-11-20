import { screen } from '@testing-library/react-native';
import { View } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomScreen } from '../features/studyroom/room';
import { useLiveRoom } from '../lib/livekit';
import { socket } from '../lib/socket';
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
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
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

// 실기기(서버 모드) 피드백: 방에 들어가자마자 멤버 전원이 보였다가 1초쯤 뒤 없는 사람이 사라졌다.
// 캠 · 음성(LiveKit)이 붙기 전에는 누가 접속해 있는지 모르니 나만 보이고, 붙으면 바로 채운다
it('미디어가 붙기 전에는 나만 보인다(멤버 전원이 보였다가 사라지는 깜빡임 없이)', async () => {
  jest
    .mocked(useLiveRoom)
    .mockReturnValue(
      live({ connected: false, participantState: () => ({ camOn: false, micOn: false }) } as never),
    );
  // 붙은 뒤(접속한 사람만)는 studyroom-presence 시험이 본다
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText('1명 접속중')).toBeTruthy();
  expect(screen.getAllByText('나').length).toBeGreaterThan(0);
  expect(screen.queryByText('앞선이')).toBeNull();
  expect(screen.queryByText('나간이')).toBeNull();
});

// 캠 · 음성이 실패하거나 다시 붙는 중이어도, 서버가 아는 「이 방 화면에 들어와 있는 사람」은 보인다(code-review)
it('미디어 없이도 소켓 접속 현황(rooms:watch)에 있는 사람은 보인다', async () => {
  jest.mocked(socket.emit).mockImplementation(((
    ev: string,
    _p: unknown,
    ack?: (r: unknown) => void,
  ) => {
    if (ev === 'rooms:watch') ack?.({ ok: true, live: { r1: ['me', 'early'] } });
  }) as never);
  jest.mocked(useLiveRoom).mockReturnValue(
    live({
      connected: false,
      error: '캠·음성을 연결하지 못했어요',
      participantState: () => ({ camOn: false, micOn: false }),
    } as never),
  );
  await renderScreen(<RoomScreen />, client());
  expect(await screen.findByText('앞선이')).toBeTruthy();
  expect(screen.queryByText('나간이')).toBeNull();
  expect(screen.getByText('2명 접속중')).toBeTruthy();
});

// 실기기 피드백(cam.png): 캠 영상이 타일 테두리 안쪽에 네모로 깔려 검은 바탕 · 테두리 틈이 보였다
it('캠 영상은 타일을 꽉 채우고 같은 둥근 모서리로 잘린다 · 말하는 테두리는 영상 위에 그린다', async () => {
  jest.mocked(useLiveRoom).mockReturnValue(
    live({
      camOn: true,
      video: (id: string) => (id === 'early' ? <View testID="cam-early" /> : null),
      participantState: (id: string) =>
        id === 'early'
          ? { camOn: true, micOn: true, speaking: true, present: true, joinedAt: mockNow }
          : { camOn: false, micOn: true, speaking: false, present: true, joinedAt: mockNow },
    }),
  );
  await renderScreen(<RoomScreen />, client());
  const video = await screen.findByTestId('cam-early');
  let tile = video.parent;
  while (tile && !String(tile.props.className).includes('w-[48.5%]')) tile = tile.parent;
  const cls = String(tile?.props.className);
  // 타일 자체에는 테두리가 없어야 영상(absolute 100%)이 타일 전체를 덮고, overflow-hidden 이 둥근 모서리로 자른다
  expect(cls).toMatch(/\boverflow-hidden\b/);
  expect(cls).toMatch(/\brounded-2xl\b/);
  expect(cls).not.toMatch(/\bborder-2\b/);
  // 말하는 중 테두리는 영상 위에 겹친 고리로
  const ring = screen.getByTestId('tile-ring-early');
  expect(String(ring.props.className)).toMatch(/\bborder-brand\b/);
  expect(String(ring.props.className)).toMatch(/\babsolute\b/);
});
