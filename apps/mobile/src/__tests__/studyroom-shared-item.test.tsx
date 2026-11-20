import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { RoomSharedItemScreen } from '../features/studyroom/room-shared-item';
import { renderScreen, setParams } from '../test-utils';

// #481: 방 멤버가 공유받은 퀴즈를 풀어 보고(기록 · 복습에 남기지 않음) 카드 묶음을 뒤집어 본다
const mockApi = {
  rooms: { sharedItem: jest.fn() },
  quiz: { startAttempt: jest.fn(), answer: jest.fn(), finish: jest.fn(), saveToBox: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));

const item = (over: object) => ({
  _id: 'it1',
  roomId: 'r1',
  sharedBy: 'u2',
  sharedByNickname: '민수',
  quizSetId: null,
  folderId: null,
  materialId: null,
  questionIds: [],
  flashcardIds: [],
  createdAt: '2026-11-20T00:00:00.000Z',
  ...over,
});
const question = (id: string, prompt: string, choices: string[] | null, answer: string) => ({
  _id: id,
  order: 1,
  type: choices ? 'multiple_choice' : 'short_answer',
  prompt,
  choices,
  answer,
  explanation: `${answer}이 정답`,
  conceptTags: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  setParams({ id: 'r1', item: 'it1' });
});

it('공유받은 퀴즈를 기기에서 채점하며 풀고, 서버 풀이 · 보관함에는 남기지 않는다', async () => {
  mockApi.rooms.sharedItem.mockResolvedValue({
    item: item({ itemType: 'quiz', title: '교착 상태 퀴즈' }),
    quiz: {
      title: '교착 상태 퀴즈',
      questions: [
        question('q1', '교착 상태 조건이 아닌 것은?', ['상호 배제', '선점'], '선점'),
        question('q2', 'CPU를 기다리는 상태는?', null, '준비'),
      ],
    },
    flashcards: [],
  });
  await renderScreen(<RoomSharedItemScreen />);
  expect(await screen.findByText('교착 상태 퀴즈')).toBeTruthy();
  expect(screen.getByText('민수님이 공유했어요 · 풀어도 내 기록에는 남지 않아요')).toBeTruthy();
  expect(mockApi.rooms.sharedItem).toHaveBeenCalledWith('r1', 'it1');
  await fireEvent.press(screen.getByText('상호 배제'));
  expect(screen.getByText('틀렸어요 · 정답: 선점')).toBeTruthy();
  expect(screen.getByText('선점이 정답')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '다음 문제' }));
  expect(screen.getByText('CPU를 기다리는 상태는?')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('답을 입력하세요'), ' 준비 ');
  await fireEvent.press(screen.getByRole('button', { name: '채점하기' }));
  expect(screen.getByText('맞았어요')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '결과 보기' }));
  expect(screen.getByText('2문제 중 1문제 맞혔어요')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '다시 풀기' }));
  expect(screen.getByText('교착 상태 조건이 아닌 것은?')).toBeTruthy();
  Object.values(mockApi.quiz).forEach((fn) => expect(fn).not.toHaveBeenCalled());
});

it('선택지가 빈 배열인 문제는 단답형으로 풀린다', async () => {
  mockApi.rooms.sharedItem.mockResolvedValue({
    item: item({ itemType: 'quiz', title: '빈 선택지' }),
    quiz: { title: '빈 선택지', questions: [question('q1', '준비 상태는?', [], '준비')] },
    flashcards: [],
  });
  await renderScreen(<RoomSharedItemScreen />);
  await fireEvent.changeText(await screen.findByPlaceholderText('답을 입력하세요'), '준비');
  await fireEvent.press(screen.getByRole('button', { name: '채점하기' }));
  expect(screen.getByText('맞았어요')).toBeTruthy();
});

it('공유받은 카드 묶음을 고른 순서대로 보고 눌러서 뒤집는다', async () => {
  mockApi.rooms.sharedItem.mockResolvedValue({
    item: item({ itemType: 'flashcards', title: '플래시카드 2장' }),
    quiz: null,
    flashcards: [
      { _id: 'c2', front: '세마포어', back: '카운터' },
      { _id: 'c1', front: '뮤텍스', back: '한 번에 하나' },
    ],
  });
  await renderScreen(<RoomSharedItemScreen />);
  expect(await screen.findByText('플래시카드 2장')).toBeTruthy();
  const fronts = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
  expect(fronts.filter((l) => String(l).startsWith('문제'))).toEqual([
    '문제: 세마포어. 눌러서 카드를 뒤집기',
    '문제: 뮤텍스. 눌러서 카드를 뒤집기',
  ]);
  await fireEvent.press(screen.getByText('세마포어'));
  expect(screen.getByText('카운터')).toBeTruthy();
});

it('지워졌거나 볼 수 없는 자료면 안내하고 다시 시도할 수 있다', async () => {
  mockApi.rooms.sharedItem.mockRejectedValueOnce(new Error('404'));
  await renderScreen(<RoomSharedItemScreen />);
  expect(await screen.findByText('지워졌거나 더 볼 수 없는 자료예요')).toBeTruthy();
  mockApi.rooms.sharedItem.mockResolvedValue({
    item: item({ itemType: 'flashcards', title: '플래시카드 1장' }),
    quiz: null,
    flashcards: [{ _id: 'c1', front: '뮤텍스', back: '한 번에 하나' }],
  });
  await fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(screen.getByText('뮤텍스')).toBeTruthy());
});
