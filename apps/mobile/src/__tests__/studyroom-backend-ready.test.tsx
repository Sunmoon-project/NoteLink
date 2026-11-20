import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomCardsScreen } from '../features/studyroom/room';
import { InviteScreen, ScheduleScreen, TimerScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: {
    get: jest.fn(),
    schedule: jest.fn(),
    shared: jest.fn(),
    setTimer: jest.fn(),
    chatRoomId: jest.fn(),
  },
  social: { friends: jest.fn(), messages: jest.fn() },
  content: { material: jest.fn() },
};
const mockOpen = jest.fn();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/upload', () => ({ uploadToBlob: jest.fn() }));
jest.mock('../lib/livekit', () => ({ useLiveRoom: jest.fn() }));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
jest.mock('../lib/feature-navigation', () => ({ useFeatureNavigation: () => mockOpen }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-calendar', () => ({}));

const room = { _id: 'r1', title: '방', hostId: 'host', inviteCode: 'ABC', members: [] };
const item = (over: object) => ({
  _id: 'i1',
  title: '공유 항목',
  sharedByNickname: '민수',
  quizSetId: null,
  materialId: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  setParams({ id: 'r1' });
  useAuth.setState({ userId: 'host' });
  mockApi.rooms.get.mockResolvedValue(room);
  mockApi.social.friends.mockResolvedValue([]);
  mockApi.rooms.chatRoomId.mockResolvedValue('chat-1');
  mockApi.social.messages.mockResolvedValue([]);
});

it.each([
  ['시간표', ScheduleScreen, 'schedule', '멤버 일정을 불러오지 못했어요'],
  ['공유 자료', RoomCardsScreen, 'shared', '공유 자료를 불러오지 못했어요'],
  ['타이머', TimerScreen, 'get', '방 설정을 불러오지 못했어요'],
  ['초대', InviteScreen, 'get', '방 정보를 불러오지 못했어요'],
] as const)('%s 조회가 실패하면 빈 화면 대신 재시도할 수 있다', async (_, Screen, method, text) => {
  mockApi.rooms.schedule.mockResolvedValue({ members: [], grid: [], matches: [], startHour: 9 });
  mockApi.rooms.shared.mockResolvedValue({ items: [], flashcards: [] });
  mockApi.rooms[method].mockRejectedValueOnce(new Error('404'));
  await renderScreen(<Screen />);
  await fireEvent.press(await screen.findByText('다시 시도', {}, { timeout: 3000 }));
  await waitFor(() => expect(mockApi.rooms[method]).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(text)).toBeNull());
});

it('공유된 퀴즈 · 카드 묶음은 공유 항목 화면으로(남의 퀴즈라 내 풀이 화면이 아니라), 노트는 노트 화면으로 연다', async () => {
  mockApi.rooms.shared.mockResolvedValue({
    items: [
      item({ _id: 'q', itemType: 'quiz', quizSetId: 'set-1', title: '중간고사 퀴즈' }),
      item({ _id: 'c', itemType: 'flashcards', flashcardIds: ['c1'], title: '플래시카드 1장' }),
      item({ _id: 'm', itemType: 'material', materialId: 'mat-1', title: '필기 자료' }),
    ],
    flashcards: [],
  });
  await renderScreen(<RoomCardsScreen />);
  expect(await screen.findByText('민수 · 퀴즈')).toBeTruthy();
  expect(screen.getByText('민수 · 플래시카드')).toBeTruthy();
  await fireEvent.press(await screen.findByText('중간고사 퀴즈'));
  expect(mockOpen).toHaveBeenCalledWith({
    pathname: '/room/shared-item',
    params: { id: 'r1', item: 'q' },
  });
  await fireEvent.press(screen.getByText('플래시카드 1장'));
  expect(mockOpen).toHaveBeenCalledWith({
    pathname: '/room/shared-item',
    params: { id: 'r1', item: 'c' },
  });
  mockApi.content.material.mockResolvedValue({ _id: 'mat-1', kind: 'document' });
  await fireEvent.press(screen.getByText('필기 자료'));
  await waitFor(() =>
    expect(mockOpen).toHaveBeenCalledWith({
      pathname: '/(tabs)/note/doc/[id]',
      params: { id: 'mat-1' },
    }),
  );
});

it.each([
  ['handwriting', '/(tabs)/note/hand/[id]'],
  ['document', '/(tabs)/note/doc/[id]'],
  ['recording', '/(tabs)/note/rec/[id]'],
] as const)('공유된 %s 노트는 종류에 맞는 화면으로 연다', async (kind, pathname) => {
  mockApi.rooms.shared.mockResolvedValue({
    items: [item({ _id: 'm', itemType: 'material', materialId: 'mat-9', title: '공유 노트' })],
    flashcards: [],
  });
  mockApi.content.material.mockResolvedValue({ _id: 'mat-9', kind });
  await renderScreen(<RoomCardsScreen />);
  // 아래 「채팅에 올린 사진 · 파일」과 같은 섹션 제목
  expect(await screen.findByText('공유한 자료')).toBeTruthy();
  await fireEvent.press(await screen.findByText('공유 노트'));
  await waitFor(() => expect(mockOpen).toHaveBeenCalledWith({ pathname, params: { id: 'mat-9' } }));
  expect(mockApi.content.material).toHaveBeenCalledWith('mat-9');
});

it('공유 노트를 조회하지 못하면 토스트로 알리고, 조회 중 같은 항목을 또 눌러도 한 번만 조회한다', async () => {
  mockApi.rooms.shared.mockResolvedValue({
    items: [item({ _id: 'm', itemType: 'material', materialId: 'mat-9', title: '공유 노트' })],
    flashcards: [],
  });
  let fail!: (e: Error) => void;
  mockApi.content.material.mockReturnValue(new Promise((_, reject) => (fail = reject)));
  await renderScreen(<RoomCardsScreen />);
  const row = await screen.findByText('공유 노트');
  await fireEvent.press(row);
  await fireEvent.press(row);
  expect(mockApi.content.material).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error('404')));
  await waitFor(() => expect(useToast.getState().msg).toBe('이 자료를 열 수 없어요'));
  expect(mockOpen).not.toHaveBeenCalled();
});

it('공유 자료가 없으면 비어 있다고 안내한다', async () => {
  mockApi.rooms.shared.mockResolvedValue({ items: [], flashcards: [] });
  await renderScreen(<RoomCardsScreen />);
  expect(await screen.findByText('아직 공유된 자료가 없어요')).toBeTruthy();
});

// 실기기 피드백(2026-11-20): 방 채팅에 올린 사진 · 파일도 공유 자료에서 함께 본다
it('공유 자료에 방 채팅에 올린 사진 · 파일을 최근 것부터 보여 준다', async () => {
  mockApi.rooms.shared.mockResolvedValue({ items: [], flashcards: [] });
  const att = (id: string, kind: 'image' | 'file', name: string, at: string) => ({
    _id: id,
    chatRoomId: 'chat-1',
    senderId: 'u2',
    senderNickname: '민수',
    type: kind,
    text: null,
    sharedItemId: null,
    attachment: { kind, name, sizeBytes: 10, url: `https://store/${name}` },
    createdAt: at,
  });
  mockApi.social.messages.mockResolvedValue([
    att('a1', 'image', '칠판.jpg', '2026-11-17T00:00:00.000Z'),
    {
      ...att('t1', 'image', 'x', '2026-11-17T01:00:00.000Z'),
      type: 'text',
      attachment: undefined,
      text: '안녕',
    },
    att('a2', 'file', '요약.pdf', '2026-11-18T00:00:00.000Z'),
  ]);
  await renderScreen(<RoomCardsScreen />);
  expect(await screen.findByText('채팅에 올린 사진 · 파일')).toBeTruthy();
  const names = screen.getAllByText(/칠판\.jpg|요약\.pdf/).map((n) => n.props.children);
  expect(names).toEqual(['요약.pdf', '칠판.jpg']);
  expect(screen.queryByText('안녕')).toBeNull();
  expect(screen.queryByText('아직 공유된 자료가 없어요')).toBeNull();
});

it('타이머는 방장만 저장할 수 있다', async () => {
  useAuth.setState({ userId: 'member' });
  await renderScreen(<TimerScreen />);
  expect(await screen.findByRole('button', { name: '방장만 바꿀 수 있어요' })).toBeDisabled();
  expect(mockApi.rooms.setTimer).not.toHaveBeenCalled();
});

it.each([
  ['타이머', TimerScreen, 'room', '저장하기'],
  ['시간표', ScheduleScreen, 'room-schedule', '이번 주 공동 학습 가능 시간 조율'],
  ['초대', InviteScreen, 'room', '스터디룸 초대 코드'],
] as const)(
  '%s 화면은 재조회가 실패해도 이미 불러온 내용을 유지한다',
  async (_, Screen, key, text) => {
    mockApi.rooms.schedule.mockResolvedValue({ members: [], grid: [], matches: [], startHour: 9 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderScreen(<Screen />, qc);
    await screen.findByText(text);
    mockApi.rooms.get.mockRejectedValue(new Error('일시 오류'));
    mockApi.rooms.schedule.mockRejectedValue(new Error('일시 오류'));
    await act(async () => {
      await qc.refetchQueries({ queryKey: [key, 'r1'] });
      // 쿼리 상태 알림은 다음 틱에 화면에 반영된다
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByText('다시 시도')).toBeNull();
  },
);
