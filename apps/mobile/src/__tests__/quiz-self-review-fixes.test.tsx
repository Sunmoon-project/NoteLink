import { act, fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { QuizSet } from '@notelink/shared';
import { QuizHomeScreen, QuizSimilarScreen, QuizSolveScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { useQuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const quizSet = (questions: unknown[]) =>
  ({
    _id: 'set-1',
    title: '퀴즈',
    status: 'ready',
    questionCount: questions.length,
    questions,
  }) as QuizSet;
afterEach(() => {
  jest.restoreAllMocks();
  useQuizProgress.getState().reset();
});

it('문제가 없는 퀴즈는 로딩에 갇히지 않고 돌아갈 수 있다', async () => {
  const back = jest.spyOn(router, 'back').mockImplementation(() => {});
  jest.spyOn(api.quiz, 'set').mockResolvedValue(quizSet([]));
  jest.spyOn(api.quiz, 'startAttempt').mockResolvedValue({ _id: 'a1' } as never);
  setParams({ setId: 'set-1' });
  await renderScreen(<QuizSolveScreen />, client());
  await fireEvent.press(await screen.findByText('돌아가기'));
  expect(back).toHaveBeenCalled();
});

it('재조회가 실패해도 풀던 문제 화면을 유지한다', async () => {
  const question = { _id: 'q1', prompt: '첫 문제', choices: ['가', '나'], answer: '가', order: 1 };
  const get = jest.spyOn(api.quiz, 'set').mockResolvedValue(quizSet([question]));
  jest.spyOn(api.quiz, 'startAttempt').mockResolvedValue({ _id: 'a1' } as never);
  const qc = client();
  setParams({ setId: 'set-1' });
  await renderScreen(<QuizSolveScreen />, qc);
  await screen.findByText('첫 문제');
  get.mockRejectedValue(new Error('일시 오류'));
  await act(async () => {
    await qc.refetchQueries({ queryKey: ['quiz-set', 'set-1'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByText('첫 문제')).toBeTruthy();
  expect(screen.queryByText('퀴즈를 불러오지 못했어요')).toBeNull();
});

it('유사 퀴즈는 만들기 전에 완료로 안내하지 않는다', async () => {
  setParams({ setId: 'set-1' });
  await renderScreen(<QuizSimilarScreen />, client());
  expect(screen.queryByText(/문제를 새로 만들었어요/)).toBeNull();
  expect(await screen.findByText('원본과 같은 난이도로 새 문제를 만들어요')).toBeTruthy();
});

it('홈의 진행 막대는 진행 정보가 없으면 100%로 표시하지 않는다', async () => {
  jest.spyOn(api.quiz, 'sets').mockResolvedValue([quizSet([{}, {}])]);
  setParams({});
  await renderScreen(<QuizHomeScreen />, client());
  expect(await screen.findByText(/퀴즈 · 2문제/)).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('조회 실패 안내를 닫거나 재시도가 또 실패해도 다시 시도할 수 있다', async () => {
  const sets = jest.spyOn(api.quiz, 'sets').mockRejectedValue(new Error('실패'));
  setParams({});
  await renderScreen(<QuizHomeScreen />, client());
  await fireEvent.press(await screen.findByText('다시 시도'));
  await fireEvent.press(await screen.findByText('다시 불러오기'));
  await act(async () => {});
  expect(sets.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(screen.getByText('다시 불러오기')).toBeTruthy();
});
