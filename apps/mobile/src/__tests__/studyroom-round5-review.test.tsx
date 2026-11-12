import { useAuth } from '../stores/auth';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { RoomCreateScreen, RoomScreen } from '../features/studyroom/room';
import { InviteScreen, RoomSettingsScreen, TimerScreen } from '../features/studyroom/tools';
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
    setTimer: jest.fn(),
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
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
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
  hostId: 'host-1',
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
    participantState: jest.fn(() => ({ camOn: false, micOn: false })),
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
  mockApi.rooms.setTimer.mockResolvedValue(room);
  mockApi.rooms.create.mockResolvedValue({ ...room, _id: 'created-room' });
  mockApi.rooms.invite.mockResolvedValue(undefined);
  mockApi.rooms.leave.mockResolvedValue(undefined);
  mockApi.rooms.chatRoomId.mockResolvedValue('chat-1');
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.social.friends.mockResolvedValue([friend]);
  useNet.setState({ state: 'ok' });
  useToast.setState({ msg: null });
  setParams({ id: room._id });
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
});

/** 연결이 5분 넘게 끊겨 자동 퇴장될 때까지 시간을 돌린다 */
async function kickOut() {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  await act(async () => useNet.getState().set('unstable'));
  await act(async () => void jest.advanceTimersByTime(5 * 60 * 1000));
  jest.useRealTimers();
  await act(async () => useNet.getState().set('ok'));
}

it('RoomScreen이 강제 퇴장 상태가 되면 확인 버튼을 기다리지 않고 미디어를 닫는다', async () => {
  const connection = media();
  mockConnectMedia.mockResolvedValue(connection);
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(room.title);
  await waitFor(() => expect(screen.getByText('듣기 켜짐')).toBeTruthy());
  await kickOut();
  expect(await screen.findByText('스터디룸에서 나갔어요')).toBeTruthy();
  await waitFor(() => expect(connection.close).toHaveBeenCalledTimes(1));
});

it('같은 방의 미디어 접속 실패 뒤 다시 입장하면 새 연결을 시도하고 이전 오류를 지운다', async () => {
  mockConnectMedia
    .mockRejectedValueOnce(new Error('미디어 서버 일시 장애'))
    .mockResolvedValueOnce(media());
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(/캠·음성을 연결하지 못했어요/);
  await kickOut();
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
  await kickOut();
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
      expect(router.push).toHaveBeenCalledWith({
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
    expect(router.push).not.toHaveBeenCalled();
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

it('강제 퇴장 없이 최초 미디어 연결 실패를 화면에서 재시도하고 정상 연결로 복구한다', async () => {
  const pending = deferred<MediaConnection>();
  mockConnectMedia
    .mockRejectedValueOnce(new Error('최초 연결 실패'))
    .mockReturnValueOnce(pending.promise);
  await renderScreen(<RoomScreen />, client());
  await screen.findByText(/캠·음성을 연결하지 못했어요/);
  expect(screen.queryByText('스터디룸에서 나갔어요')).toBeNull();
  await fireEvent.press(await screen.findByRole('button', { name: '미디어 다시 연결' }));
  await waitFor(() => expect(mockConnectMedia).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: '미디어 다시 연결' })).toBeNull();
  await act(async () => pending.resolve(media()));
  expect(await screen.findByText('듣기 켜짐')).toBeTruthy();
  expect(screen.queryByText(/캠·음성을 연결하지 못했어요/)).toBeNull();
});

it('미디어 재연결도 실패하면 다시 시도할 수 있고 오프라인에서는 새 연결을 시작하지 않는다', async () => {
  mockConnectMedia
    .mockRejectedValueOnce(new Error('최초 실패'))
    .mockRejectedValueOnce(new Error('재연결 실패'))
    .mockResolvedValueOnce(media());
  await renderScreen(<RoomScreen />, client());
  await fireEvent.press(await screen.findByRole('button', { name: '미디어 다시 연결' }));
  await waitFor(() => expect(mockConnectMedia).toHaveBeenCalledTimes(2));
  await screen.findByRole('button', { name: '미디어 다시 연결' });
  await act(async () => useNet.setState({ state: 'offline' }));
  await fireEvent.press(screen.getByRole('button', { name: '미디어 다시 연결' }));
  expect(mockConnectMedia).toHaveBeenCalledTimes(2);
  expect(useToast.getState().msg).toBe('연결을 복구한 뒤 다시 시도해 주세요');
  await act(async () => useNet.setState({ state: 'ok' }));
  await fireEvent.press(screen.getByRole('button', { name: '미디어 다시 연결' }));
  await waitFor(() => expect(mockConnectMedia).toHaveBeenCalledTimes(3));
  expect(await screen.findByText('듣기 켜짐')).toBeTruthy();
});

it('연결에 성공한 미디어만 종료되면 오류와 재연결 버튼을 표시하고 기존 연결을 정리한다', async () => {
  const first = media();
  mockConnectMedia.mockResolvedValueOnce(first).mockResolvedValueOnce(media());
  await renderScreen(<RoomScreen />, client());
  await screen.findByText('듣기 켜짐');
  await act(async () => {
    first.connected = false;
    mockConnectMedia.mock.calls[0][1]();
  });
  expect(useNet.getState().state).toBe('ok');
  await fireEvent.press(await screen.findByRole('button', { name: '미디어 다시 연결' }));
  await waitFor(() => expect(mockConnectMedia).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('듣기 켜짐')).toBeTruthy();
});

describe('교시 시간표 편집', () => {
  beforeEach(() => useAuth.setState({ userId: room.hostId }));
  async function edit() {
    await renderScreen(<TimerScreen />, client());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '저장하기' })).not.toBeDisabled(),
    );
    await fireEvent.press(screen.getByText('시간표 편집'));
    await screen.findByLabelText('교시 시작');
  }
  it('교시 시간과 이름을 편집해 미리보기와 서버 저장에 반영한다', async () => {
    await edit();
    await fireEvent.changeText(screen.getByLabelText('교시 시작'), '08:10');
    await fireEvent.changeText(screen.getByLabelText('교시 종료'), '08:55');
    await fireEvent.changeText(screen.getByLabelText('교시 이름'), '아침 복습');
    await fireEvent.press(screen.getByRole('button', { name: '교시 적용' }));
    expect(screen.getByText('08:10 - 08:55')).toBeTruthy();
    expect(screen.getByText('아침 복습')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '저장하기' }));
    await waitFor(() =>
      expect(mockApi.rooms.setTimer).toHaveBeenCalledWith(
        room._id,
        expect.objectContaining({
          periods: expect.arrayContaining([{ start: '08:10', end: '08:55', label: '아침 복습' }]),
        }),
      ),
    );
  });
  it.each([
    ['25:00', '25:50'],
    ['09:50', '09:00'],
    ['10:10', '10:40'],
  ])('잘못된 시간 또는 겹치는 구간 %s~%s는 적용하지 않는다', async (start, end) => {
    await edit();
    await fireEvent.changeText(screen.getByLabelText('교시 시작'), start);
    await fireEvent.changeText(screen.getByLabelText('교시 종료'), end);
    await fireEvent.press(screen.getByRole('button', { name: '교시 적용' }));
    expect(screen.getByLabelText('교시 시작')).toBeTruthy();
    expect(screen.getByText('09:00 - 09:50')).toBeTruthy();
    expect(useToast.getState().msg).toBeTruthy();
    expect(mockApi.rooms.setTimer).not.toHaveBeenCalled();
  });
  it('다른 교시 행에서 열어 편집하다 취소하면 기존 내용을 유지한다', async () => {
    await renderScreen(<TimerScreen />, client());
    await fireEvent.press(await screen.findByRole('button', { name: '2교시 편집' }));
    expect(screen.getByLabelText('교시 시작').props.value).toBe('10:00');
    await fireEvent.changeText(screen.getByLabelText('교시 이름'), '취소할 내용');
    await fireEvent.press(screen.getByRole('button', { name: '취소' }));
    expect(screen.getByText('2교시')).toBeTruthy();
    expect(screen.queryByText('취소할 내용')).toBeNull();
  });
});
