import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { Flashcard } from '@notelink/shared';
import {
  FlashScreen,
  QuizGenScreen,
  QuizSimilarScreen,
  QuizSolveScreen,
} from '../features/quiz/quiz';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  clients.push(qc);
  return qc;
};
beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  jest.restoreAllMocks();
});

it('주관식 문제에 답을 입력하고 서버에 제출한다', async () => {
  const set = await api.quiz.set('qs1');
  const original = set.questions[0]!;
  const question = { ...original, type: 'short_answer' as const, choices: null, answer: '광합성' };
  const attempt = await api.quiz.startAttempt(set._id);
  jest
    .spyOn(api.quiz, 'set')
    .mockResolvedValue({ ...set, questions: [question], questionCount: 1 });
  const start = jest.spyOn(api.quiz, 'startAttempt').mockResolvedValue(attempt);
  const answer = jest
    .spyOn(api.quiz, 'answer')
    .mockResolvedValue({ correct: true, correctAnswer: '광합성' });
  setParams({ setId: set._id });
  await renderScreen(<QuizSolveScreen />, client());
  await waitFor(() => expect(start).toHaveBeenCalled());
  await fireEvent.changeText(await screen.findByPlaceholderText('답을 입력해주세요'), '광합성');
  await fireEvent.press(screen.getByText('답 제출'));
  await waitFor(() => expect(answer).toHaveBeenCalledWith(attempt._id, question._id, '광합성'));
  expect(await screen.findByText('정답이에요')).toBeTruthy();
});

it('풀이 시작 실패 후 같은 화면에서 재시도할 수 있다', async () => {
  const set = await api.quiz.set('qs1');
  const attempt = await api.quiz.startAttempt(set._id);
  jest.spyOn(api.quiz, 'set').mockResolvedValue(set);
  const start = jest
    .spyOn(api.quiz, 'startAttempt')
    .mockRejectedValueOnce(new Error('시작 요청 실패'))
    .mockResolvedValue(attempt);
  setParams({ setId: set._id });
  await renderScreen(<QuizSolveScreen />, client());
  await fireEvent.press(await screen.findByText('다시 시작'));
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('다시 시작')).toBeNull();
});

it('생성 응답 전 취소해도 뒤늦게 생긴 서버 작업을 취소하고 다음 화면을 열지 않는다', async () => {
  const created = await api.quiz.createSet('ma1');
  const delayed = deferred<typeof created>();
  jest.spyOn(api.quiz, 'createSet').mockReturnValue(delayed.promise);
  const cancel = jest.spyOn(api.ai, 'cancel').mockResolvedValue(undefined);
  setParams({ materialId: 'ma1', title: '취소할 노트' });
  await renderScreen(<QuizGenScreen />, client());
  await fireEvent.press(screen.getByText('취소'));
  expect(router.back).toHaveBeenCalledTimes(1);
  await act(async () => delayed.resolve(created));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(created.job._id));
  expect(router.replace).not.toHaveBeenCalled();
});

it('유사 퀴즈 저장 응답 대기 중 같은 문제를 연속 저장하지 않는다', async () => {
  const sim = await api.quiz.similar('qs1');
  const card = await api.quiz.saveFlashcard({ front: '앞', back: '뒤' });
  jest.spyOn(api.quiz, 'similar').mockResolvedValue(sim);
  const delayed = deferred<typeof card>();
  const save = jest.spyOn(api.quiz, 'saveFlashcard').mockReturnValue(delayed.promise);
  setParams({ setId: 'qs1' });
  await renderScreen(<QuizSimilarScreen />, client());
  await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
  const button = (await screen.findAllByText('플래시카드 저장'))[0]!;
  const user = userEvent.setup();
  try {
    await user.press(button);
    await user.press(button);
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => delayed.resolve(card));
  }
});

const flash = (id: string): Flashcard => ({
  _id: id,
  materialId: null,
  folderId: 'fo1',
  lastResult: null,
  front: `앞 ${id}`,
  back: `뒤 ${id}`,
  sourceQuizSetId: null,
  sourceQuestionId: null,
  createdAt: '2026-10-29T00:00:00.000Z',
});

it('마지막 카드를 삭제하면 남은 마지막 카드와 올바른 위치를 표시한다', async () => {
  const cards = [flash('1'), flash('2'), flash('3')];
  jest.spyOn(api.quiz, 'flashcards').mockResolvedValue(cards);
  const qc = client();
  qc.setQueryData(['flashcards'], cards);
  setParams({ i: '2' });
  await renderScreen(<FlashScreen />, qc);
  expect(await screen.findByText('뒤 3')).toBeTruthy();
  await act(async () => {
    qc.setQueryData(['flashcards'], cards.slice(0, 2));
  });
  expect(await screen.findByText('뒤 2')).toBeTruthy();
  expect(screen.getByText('2 / 2')).toBeTruthy();
  expect(screen.queryByText('3 / 2')).toBeNull();
});

it('카드가 모두 삭제되면 빈 상태를 표시하고 위치를 1 / 0으로 표시하지 않는다', async () => {
  const cards = [flash('1')];
  jest.spyOn(api.quiz, 'flashcards').mockResolvedValue(cards);
  const qc = client();
  qc.setQueryData(['flashcards'], cards);
  await renderScreen(<FlashScreen />, qc);
  expect(await screen.findByText('뒤 1')).toBeTruthy();
  await act(async () => {
    qc.setQueryData(['flashcards'], []);
  });
  expect(await screen.findByText('저장한 플래시카드가 없어요')).toBeTruthy();
  expect(screen.queryByText('1 / 0')).toBeNull();
});

it('카드 최초 조회를 기다리는 동안 요청한 세 번째 카드 위치를 보존한다', async () => {
  const cards = [flash('1'), flash('2'), flash('3')];
  const delayed = deferred<Flashcard[]>();
  const fetch = jest.spyOn(api.quiz, 'flashcards').mockReturnValue(delayed.promise);
  setParams({ i: '2' });
  await renderScreen(<FlashScreen />, client());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('뒤 1')).toBeNull();
  await act(async () => delayed.resolve(cards));
  expect(await screen.findByText('뒤 3')).toBeTruthy();
  expect(screen.getByText('3 / 3')).toBeTruthy();
});
