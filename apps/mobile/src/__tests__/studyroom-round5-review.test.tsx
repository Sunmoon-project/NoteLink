import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RoomCreateScreen, RoomScreen } from '../features/studyroom/room';
import { InviteScreen, RoomSettingsScreen } from '../features/studyroom/tools';
import { useMockFlags } from '../lib/mock/flags';
import { useNet } from '../stores/net';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';
import type { MediaConnection } from '../lib/livekit-native';

const mockApi = {
  rooms: {
    get: jest.fn(),
    create: jest.fn(),
    invite: jest.fn(),
    leave: jest.fn(),
    chatRoomId: jest.fn(),
  },
  social: { friends: jest.fn(), messages: jest.fn() },
};
const mockConnectMedia = jest.fn();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { useMock: false, apiUrl: 'http://api' } }));
jest.mock('../lib/livekit-loader', () => ({
  loadMedia: async () => ({ connectMedia: (...args: unknown[]) => mockConnectMedia(...args) }),
}));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: jest.fn(() => () => {}) } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0 } }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  useLocalSearchParams: () => globalThis.mockParams,
  useSegments: () => [],
  useSitemap: () => null,
}));

const room = {
  _id: 'room-1',
  title: '테스트 스터디룸',
  inviteCode: 'AB1234',
  members: [],
  timerRule: null,
};
const friend = { _id: 'friend-row', userId: 'friend-1', nickname: '초대할 친구', status: 'active' };
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30000, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
}
function media() {
  return {
    connected: true,
    micOn: false,
    camOn: false,
    hearing: true,
    toggleMic: jest.fn(async () => {}),
    toggleCam: jest.fn(async () => {}),
    toggleHearing: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    video: jest.fn(() => null),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockConnectMedia.mockReset();
  mockConnectMedia.mockResolvedValue(media());
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.rooms.create.mockResolvedValue({ ...room, _id: 'created-room' });
  mockApi.rooms.invite.mockResolvedValue(undefined);
  mockApi.rooms.leave.mockResolvedValue(undefined);
  mockApi.rooms.chatRoomId.mockResolvedValue('chat-1');
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.social.friends.mockResolvedValue([friend]);
  useMockFlags.getState().reset();
  useNet.setState({ state: 'ok' });
  useToast.setState({ msg: null });
  setParams({ id: room._id });
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
});

it('RoomScreen이 강제 퇴장 상태가 되면 확인 버튼을 기다리지 않고 미디어를 닫는다', async () => {
  const connection = media();
  mockConnectMedia.mockResolvedValue(connection);
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await waitFor(() => expect(screen.getByText('듣기 켜짐')).toBeTruthy());
  await act(async () => useMockFlags.setState({ roomKick: true }));
  expect(await screen.findByText('스터디룸에서 나갔어요')).toBeTruthy();
  await waitFor(() => expect(connection.close).toHaveBeenCalledTimes(1));
});

it('같은 방의 미디어 접속 실패 뒤 다시 입장하면 새 연결을 시도하고 이전 오류를 지운다', async () => {
  mockConnectMedia
    .mockRejectedValueOnce(new Error('미디어 서버 일시 장애'))
    .mockResolvedValueOnce(media());
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(/캠·음성을 연결하지 못했어요/);
  await act(async () => useMockFlags.setState({ roomKick: true }));
  await fireEvent.press(await screen.findByText('다시 입장'));
  await waitFor(() => expect(mockConnectMedia).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/캠·음성을 연결하지 못했어요/)).toBeNull());
  expect(screen.getByText('듣기 켜짐')).toBeTruthy();
});

it('퇴장 후 늦게 완료된 미디어 연결은 활성화하지 않고 정리한다', async () => {
  const pending = deferred<MediaConnection>();
  const connection = media();
  mockConnectMedia.mockReturnValue(pending.promise);
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await waitFor(() => expect(mockConnectMedia).toHaveBeenCalledTimes(1));
  await act(async () => useMockFlags.setState({ roomKick: true }));
  await screen.findByText('스터디룸에서 나갔어요');
  await act(async () => pending.resolve(connection));
  await waitFor(() => expect(connection.close).toHaveBeenCalledTimes(1));
});

describe('RoomCreateScreen', () => {
  async function fill() {
    await fireEvent.changeText(
      screen.getByPlaceholderText('예) 파이썬 기초 스터디'),
      '  새 수학방  ',
    );
    await fireEvent.press(screen.getByText('수학'));
    await fireEvent.press(screen.getByText('비공개'));
  }
  it('이름·카테고리·공개여부로 생성하고 방 목록을 갱신한 뒤 새 방으로 이동한다', async () => {
    const qc = client();
    qc.setQueryData(['rooms', 'mine'], []);
    await renderScreen(<RoomCreateScreen />, qc);
    await fill();
    await fireEvent.press(screen.getByRole('button', { name: '스터디룸 만들기' }));
    await waitFor(() =>
      expect(mockApi.rooms.create).toHaveBeenCalledWith({
        title: '새 수학방',
        categoryName: '수학',
        isPublic: false,
      }),
    );
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/room/[id]',
        params: { id: 'created-room' },
      }),
    );
    expect(qc.getQueryState(['rooms', 'mine'])?.isInvalidated).toBe(true);
  });
  it('생성 실패 시 입력을 유지하고 안내하며 이동·캐시 갱신을 하지 않는다', async () => {
    mockApi.rooms.create.mockRejectedValueOnce(new Error('생성 거절'));
    const qc = client();
    qc.setQueryData(['rooms', 'mine'], []);
    await renderScreen(<RoomCreateScreen />, qc);
    await fill();
    await fireEvent.press(screen.getByRole('button', { name: '스터디룸 만들기' }));
    await waitFor(() => expect(mockApi.rooms.create).toHaveBeenCalled());
    await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
    expect(screen.getByPlaceholderText('예) 파이썬 기초 스터디').props.value).toBe('  새 수학방  ');
    expect(router.replace).not.toHaveBeenCalled();
    expect(qc.getQueryState(['rooms', 'mine'])?.isInvalidated).toBe(false);
  });
});

describe('InviteScreen', () => {
  it('실제 선택한 친구 ID로 초대한 뒤 완료 표시하며 돌아가기 버튼으로 방에 복귀한다', async () => {
    await renderScreen(<InviteScreen />, client());
    await screen.findByText(friend.nickname);
    await fireEvent.press(screen.getByText('초대하기'));
    await waitFor(() =>
      expect(mockApi.rooms.invite).toHaveBeenCalledWith(room._id, [friend.userId]),
    );
    expect(await screen.findByText('초대됨')).toBeTruthy();
    await fireEvent.press(screen.getByText('스터디룸으로 돌아가기'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });
  it('초대 실패 시 초대됨으로 표시하지 않고 재시도와 실패 안내를 제공한다', async () => {
    mockApi.rooms.invite.mockRejectedValueOnce(new Error('초대 거절'));
    await renderScreen(<InviteScreen />, client());
    await fireEvent.press(await screen.findByText('초대하기'));
    await waitFor(() =>
      expect(mockApi.rooms.invite).toHaveBeenCalledWith(room._id, [friend.userId]),
    );
    await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
    expect(screen.getByText('초대하기')).toBeTruthy();
    expect(screen.queryByText('초대됨')).toBeNull();
    expect(router.back).not.toHaveBeenCalled();
  });
});

describe('RoomSettingsScreen', () => {
  async function confirmLeave() {
    await fireEvent.press(screen.getByText('채팅방 나가기'));
    await fireEvent.press(await screen.findByText('확인'));
  }
  it('퇴장 성공 시 해당 방을 떠나고 방 목록 캐시 갱신 후 목록으로 돌아간다', async () => {
    const qc = client();
    qc.setQueryData(['rooms', 'mine'], [room]);
    await renderScreen(<RoomSettingsScreen />, qc);
    await confirmLeave();
    await waitFor(() => expect(mockApi.rooms.leave).toHaveBeenCalledWith(room._id));
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/studyroom'));
    expect(qc.getQueryState(['rooms', 'mine'])?.isInvalidated).toBe(true);
  });
  it('퇴장 실패 시 확인창과 방 목록을 유지하고 안내하며 이동하지 않는다', async () => {
    mockApi.rooms.leave.mockRejectedValueOnce(new Error('퇴장 거절'));
    const qc = client();
    qc.setQueryData(['rooms', 'mine'], [room]);
    await renderScreen(<RoomSettingsScreen />, qc);
    await confirmLeave();
    await waitFor(() => expect(mockApi.rooms.leave).toHaveBeenCalledWith(room._id));
    await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
    expect(screen.getByText('채팅방을 나가시겠어요?')).toBeTruthy();
    expect(router.dismissTo).not.toHaveBeenCalled();
    expect(qc.getQueryState(['rooms', 'mine'])?.isInvalidated).toBe(false);
  });
});
