import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RoomCardsScreen } from '../features/studyroom/room';
import { InviteScreen, ScheduleScreen, TimerScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { get: jest.fn(), schedule: jest.fn(), shared: jest.fn(), setTimer: jest.fn() },
  social: { friends: jest.fn() },
};
const mockOpen = jest.fn();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
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

it('공유된 퀴즈와 자료를 서버가 준 id로 연다', async () => {
  mockApi.rooms.shared.mockResolvedValue({
    items: [
      item({ _id: 'q', itemType: 'quiz', quizSetId: 'set-1', title: '중간고사 퀴즈' }),
      item({ _id: 'm', itemType: 'material', materialId: 'mat-1', title: '필기 자료' }),
    ],
    flashcards: [],
  });
  await renderScreen(<RoomCardsScreen />);
  await fireEvent.press(await screen.findByText('중간고사 퀴즈'));
  expect(mockOpen).toHaveBeenCalledWith({
    pathname: '/play/solve',
    params: { setId: 'set-1', from: 'room' },
  });
  await fireEvent.press(screen.getByText('필기 자료'));
  expect(mockOpen).toHaveBeenCalledWith({
    pathname: '/(tabs)/note/doc/[id]',
    params: { id: 'mat-1' },
  });
});

it('공유 자료가 없으면 비어 있다고 안내한다', async () => {
  mockApi.rooms.shared.mockResolvedValue({ items: [], flashcards: [] });
  await renderScreen(<RoomCardsScreen />);
  expect(await screen.findByText('아직 공유된 자료가 없어요')).toBeTruthy();
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
