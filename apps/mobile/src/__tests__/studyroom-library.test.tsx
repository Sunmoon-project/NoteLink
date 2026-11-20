import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

import { RoomLibraryScreen } from '../features/studyroom/room-library';
import { toast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  content: { folders: jest.fn() },
  quiz: { sets: jest.fn(), flashcards: jest.fn() },
  rooms: { shareStudyItem: jest.fn() },
};
jest.mock('../stores/toast', () => ({ toast: jest.fn() }));
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
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
    { _id: 'c3', folderId: 'f2', front: '분자란?', back: '원자의 묶음' },
  ]);
  mockApi.rooms.shareStudyItem.mockResolvedValue(undefined);
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

// #481: 방에서 내 퀴즈 · 고른 플래시카드를 방 채팅으로 공유한다
it('퀴즈 옆 「방에 공유」로 그 퀴즈를 방에 공유하고 방으로 돌아간다', async () => {
  setParams({ id: 'room1', type: 'quiz' });
  await renderScreen(<RoomLibraryScreen />);
  await fireEvent.press(await screen.findByText('생물'));
  await fireEvent.press(screen.getByRole('button', { name: '세포 퀴즈 방에 공유' }));
  await waitFor(() =>
    expect(mockApi.rooms.shareStudyItem).toHaveBeenCalledWith('room1', {
      kind: 'quiz',
      quizSetId: 'q1',
    }),
  );
  await waitFor(() => expect(router.back).toHaveBeenCalled());
  expect(toast).toHaveBeenCalledWith('방 채팅에 퀴즈를 공유했어요');
  // 공유는 풀이를 열지 않는다
  expect(router.push).not.toHaveBeenCalled();
});

it('「골라서 공유」에서 카드 오른쪽 위 체크로 여러 장을 골라 한 번에 공유한다', async () => {
  setParams({ id: 'room1', type: 'flashcards' });
  await renderScreen(<RoomLibraryScreen />);
  await fireEvent.press(await screen.findByText('화학'));
  expect(screen.queryByRole('checkbox')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '골라서 공유' }));
  const boxes = screen.getAllByRole('checkbox');
  expect(boxes).toHaveLength(2);
  // 고르는 동안 카드를 누르면 뒤집지 않고 고른다
  await fireEvent.press(screen.getByText('원자란?'));
  await fireEvent.press(screen.getByRole('checkbox', { name: '분자란? 고르기' }));
  expect(screen.queryByText('물질의 구성 단위')).toBeNull();
  expect(
    screen.getByRole('checkbox', { name: '원자란? 고르기' }).props.accessibilityState,
  ).toMatchObject({ checked: true });
  await fireEvent.press(screen.getByRole('button', { name: '2장 방에 공유' }));
  await waitFor(() =>
    expect(mockApi.rooms.shareStudyItem).toHaveBeenCalledWith('room1', {
      kind: 'flashcards',
      flashcardIds: ['c1', 'c3'],
    }),
  );
  await waitFor(() => expect(router.back).toHaveBeenCalled());
});

it('공유에 실패하면 자리에 남아 다시 보낼 수 있다', async () => {
  setParams({ id: 'room1', type: 'flashcards' });
  mockApi.rooms.shareStudyItem.mockRejectedValueOnce(new Error('network'));
  await renderScreen(<RoomLibraryScreen />);
  await fireEvent.press(await screen.findByText('화학'));
  await fireEvent.press(screen.getByRole('button', { name: '골라서 공유' }));
  await fireEvent.press(screen.getByText('원자란?'));
  await fireEvent.press(screen.getByRole('button', { name: '1장 방에 공유' }));
  await waitFor(() => expect(toast).toHaveBeenCalledWith('공유하지 못했어요. 다시 시도해 주세요'));
  expect(router.back).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '1장 방에 공유' })).toBeTruthy();
});
