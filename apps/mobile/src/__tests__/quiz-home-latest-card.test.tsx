import { fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { QuizSet } from '@notelink/shared';
import { QuizHomeScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { useQuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));

// #561: 퀴즈 탭 맨 위 「퀴즈 풀기」 카드는 끝까지 푼 세트(completed)를 건너뛴다
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const quizSet = (_id: string, title: string, over: Partial<QuizSet> = {}) =>
  ({
    _id,
    title,
    status: 'ready',
    questionCount: 2,
    questions: [],
    ...over,
  }) as QuizSet;

beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
  jest.spyOn(api.quiz, 'today').mockResolvedValue(null);
});
afterEach(() => {
  jest.restoreAllMocks();
  useQuizProgress.getState().reset();
});

it('끝까지 푼 세트는 건너뛰고 아직 안 푼 가장 최근 세트를 카드에 보여 준다', async () => {
  jest
    .spyOn(api.quiz, 'sets')
    .mockResolvedValue([
      quizSet('done', '다 푼 퀴즈', { completed: true }),
      quizSet('making', '만드는 퀴즈', { status: 'generating' }),
      quizSet('next', '안 푼 퀴즈'),
      quizSet('older', '더 옛 퀴즈'),
    ]);
  await renderScreen(<QuizHomeScreen />, client());
  expect(await screen.findByText('안 푼 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.queryByText(/다 푼 퀴즈 ·/)).toBeNull();
  await fireEvent.press(screen.getByText('안 푼 퀴즈 · 2문제'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/solve',
    params: { setId: 'next' },
  });
});

it('오늘의 복습 세트는 오늘의 복습 카드가 보여 주므로 맨 위 카드로 고르지 않는다', async () => {
  const today = quizSet('today', '오늘의 복습 · 11-19');
  jest.spyOn(api.quiz, 'sets').mockResolvedValue([today, quizSet('next', '안 푼 퀴즈')]);
  // 시험은 기기 저장 모드(localData)라 오늘의 복습 조회가 꺼져 있어, 서버에서 받은 것처럼 미리 넣는다
  const qc = client();
  qc.setQueryData(['today-review'], today);
  await renderScreen(<QuizHomeScreen />, qc);
  expect(await screen.findByText('안 푼 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.queryByText('오늘의 복습 · 11-19 · 2문제')).toBeNull();
});

it('지난 날의 안 푼 복습 사본(reviewDay)도 맨 위 카드로 고르지 않는다', async () => {
  jest
    .spyOn(api.quiz, 'sets')
    .mockResolvedValue([
      quizSet('done', '다 푼 퀴즈', { completed: true }),
      quizSet('past', '오늘의 복습 · 11-16', { reviewDay: '2026-11-16' }),
      quizSet('next', '안 푼 퀴즈', { reviewDay: null }),
    ]);
  await renderScreen(<QuizHomeScreen />, client());
  expect(await screen.findByText('안 푼 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.queryByText('오늘의 복습 · 11-16 · 2문제')).toBeNull();
});

it('모두 풀었으면 카드만 숨기고 바로가기는 남긴다(유사 퀴즈는 가장 최근 세트로)', async () => {
  jest
    .spyOn(api.quiz, 'sets')
    .mockResolvedValue([
      quizSet('done', '다 푼 퀴즈', { completed: true }),
      quizSet('old', '옛 퀴즈', { completed: true }),
    ]);
  await renderScreen(<QuizHomeScreen />, client());
  expect(await screen.findByText('유사 퀴즈')).toBeTruthy();
  expect(screen.queryByText('퀴즈 풀기')).toBeNull();
  expect(screen.queryByText(/다 푼 퀴즈 ·/)).toBeNull();
  expect(screen.queryByText('아직 만들어진 퀴즈가 없어요')).toBeNull();
  await fireEvent.press(screen.getByText('유사 퀴즈'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/similar',
    params: { setId: 'done' },
  });
});

it('풀던 진행이 있으면 다 푼 표시와 상관없이 그 세트를 이어서 풀게 한다', async () => {
  jest
    .spyOn(api.quiz, 'sets')
    .mockResolvedValue([
      quizSet('next', '안 푼 퀴즈'),
      quizSet('done', '다 푼 퀴즈', { completed: true }),
    ]);
  useQuizProgress.getState().save({
    setId: 'done',
    attemptId: 'a1',
    index: 1,
    answerText: '',
    pick: null,
    right: null,
    results: [true],
  });
  await renderScreen(<QuizHomeScreen />, client());
  // 목록이 오기 전에는 「풀던 퀴즈」로 먼저 그리므로 제목이 바뀔 때까지 기다린다
  expect(await screen.findByText('다 푼 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.getByText('이어서 풀기')).toBeTruthy();
});

it('ready 세트가 없을 때만 빈 상태를 보여 준다', async () => {
  jest.spyOn(api.quiz, 'sets').mockResolvedValue([]);
  await renderScreen(<QuizHomeScreen />, client());
  expect(await screen.findByText('아직 만들어진 퀴즈가 없어요')).toBeTruthy();
  expect(screen.queryByText('유사 퀴즈')).toBeNull();
});
