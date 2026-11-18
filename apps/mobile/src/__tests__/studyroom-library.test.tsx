import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import { RoomLibraryScreen } from '../features/studyroom/room-library';
import { renderScreen, setParams } from '../test-utils';
import { useToast } from '../stores/toast';

const mockApi = {
  content: { folders: jest.fn() },
  quiz: { sets: jest.fn(), flashcards: jest.fn() },
  rooms: { shareStudyItem: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  useToast.setState({ msg: null });
  mockApi.rooms.shareStudyItem.mockResolvedValue(undefined);
  mockApi.content.folders.mockResolvedValue([
    { _id: 'f1', title: '생물' },
    { _id: 'f2', title: '화학' },
  ]);
  mockApi.quiz.sets.mockResolvedValue([
    { _id: 'q1', folderId: 'f1', title: '세포 퀴즈', status: 'ready', questionCount: 5 },
    { _id: 'q2', folderId: 'f2', title: '만드는 중', status: 'generating', questionCount: 0 },
  ]);
  mockApi.quiz.flashcards.mockResolvedValue([
    { _id: 'c1', folderId: 'f2', front: '원자란?', back: '물질의 구성 단위' },
    { _id: 'c2', folderId: null, front: '분류 없는 카드', back: '답' },
  ]);
});

it.each([
  ['quiz', '생물', '퀴즈 공유하기', 'q1'],
  ['flashcards', '화학', '플래시 카드 공유하기', 'c1'],
] as const)('%s를 현재 스터디룸 채팅에 공유한다', async (type, folder, button, itemId) => {
  setParams({ id: 'room1', type });
  await renderScreen(<RoomLibraryScreen />);
  await fireEvent.press(await screen.findByText(folder));
  await fireEvent.press(screen.getByText(button));
  await waitFor(() =>
    expect(mockApi.rooms.shareStudyItem).toHaveBeenCalledWith('room1', type, itemId, expect.any(String)),
  );
  await waitFor(() =>
    expect(router.dismissTo).toHaveBeenCalledWith({ pathname: '/room/[id]', params: { id: 'room1' } }),
  );
});

it('공유가 실패하면 스터디룸 화면으로 이동하지 않는다', async () => {
  setParams({ id: 'room1', type: 'quiz' });
  mockApi.rooms.shareStudyItem.mockRejectedValueOnce(new Error('network'));
  await renderScreen(<RoomLibraryScreen />);
  await fireEvent.press(await screen.findByText('생물'));
  await fireEvent.press(screen.getByText('퀴즈 공유하기'));
  await waitFor(() => expect(mockApi.rooms.shareStudyItem).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useToast.getState().msg).toBe('공유하지 못했어요. 다시 시도해 주세요'));
  expect(screen.getByText('세포 퀴즈')).toBeTruthy();
  expect(router.dismissTo).not.toHaveBeenCalled();
  const firstRequestId = mockApi.rooms.shareStudyItem.mock.calls[0]![3];
  await fireEvent.press(screen.getByText('퀴즈 공유하기'));
  await waitFor(() => expect(mockApi.rooms.shareStudyItem).toHaveBeenCalledTimes(2));
  expect(mockApi.rooms.shareStudyItem.mock.calls[1]![3]).toBe(firstRequestId);
});

it('내 폴더의 완료된 퀴즈를 선택해 방에서 풀이한다', async () => {
  setParams({ id: 'room1', type: 'quiz' });
  await renderScreen(<RoomLibraryScreen />);
  await fireEvent.press(await screen.findByText('생물'));
  expect(screen.queryByText('만드는 중')).toBeNull();
  await fireEvent.press(screen.getByText('세포 퀴즈'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/solve',
    params: { setId: 'q1', from: 'room' },
  });
  expect(mockApi.quiz.flashcards).not.toHaveBeenCalled();
});

it('내 플래시카드를 폴더별로 불러와 뒤집고 폴더 없는 카드도 표시한다', async () => {
  setParams({ id: 'room1', type: 'flashcards' });
  await renderScreen(<RoomLibraryScreen />);
  await fireEvent.press(await screen.findByText('화학'));
  expect(screen.getByText('원자란?')).toBeTruthy();
  await fireEvent.press(
    screen.getByRole('button', { name: '문제: 원자란?. 눌러서 카드를 뒤집기' }),
  );
  expect(screen.getByText('물질의 구성 단위')).toBeTruthy();
  const back = screen.getByRole('button', {
    name: '정답: 물질의 구성 단위. 눌러서 카드를 뒤집기',
  });
  await fireEvent.press(back);
  expect(screen.getByRole('button', { name: '문제: 원자란?. 눌러서 카드를 뒤집기' })).toBeTruthy();
  await fireEvent.press(screen.getByText('폴더 목록'));
  await fireEvent.press(screen.getByText('폴더 없음'));
  expect(screen.getByText('분류 없는 카드')).toBeTruthy();
  expect(mockApi.quiz.sets).not.toHaveBeenCalled();
});

it('자료 조회 실패를 빈 목록과 구별하고 다시 시도한다', async () => {
  setParams({ id: 'room1', type: 'quiz' });
  mockApi.quiz.sets.mockRejectedValueOnce(new Error('network'));
  await renderScreen(<RoomLibraryScreen />);
  expect(await screen.findByText('자료를 불러오지 못했어요')).toBeTruthy();
  expect(screen.queryByText('풀 수 있는 퀴즈가 없어요')).toBeNull();
  await fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(screen.getByText('생물')).toBeTruthy());
});

it('저장한 플래시카드가 없을 때 빈 상태를 표시한다', async () => {
  setParams({ id: 'room1', type: 'flashcards' });
  mockApi.quiz.flashcards.mockResolvedValue([]);
  await renderScreen(<RoomLibraryScreen />);
  expect(await screen.findByText('저장한 플래시 카드가 없어요')).toBeTruthy();
});
