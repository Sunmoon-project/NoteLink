import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { QuizSolveScreen } from '../features/quiz/quiz';
import { seedUser } from './fixtures/seed';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

// 문제마다 처리기가 정한 난이도(#268)를 진행 줄에 보여 준다. 난이도가 없는 문제(그 전에 만든 문제)는 그대로
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockStore.delete(key)),
}));
const mockApi = {
  quiz: { set: jest.fn(), startAttempt: jest.fn(), answer: jest.fn(), finish: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ disconnectSocket: jest.fn(), socket: { emit: jest.fn() } }));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

const setId = 'quiz-difficulty';
const quizSet = {
  _id: setId,
  questionCount: 2,
  questions: [
    {
      _id: 'first',
      type: 'multiple_choice',
      prompt: '중간 난이도 문제',
      choices: ['정답', '오답'],
      answer: '정답',
      difficulty: '중',
    },
    {
      _id: 'second',
      type: 'multiple_choice',
      prompt: '난이도가 없는 문제',
      choices: ['정답', '오답'],
      answer: '정답',
      difficulty: null,
    },
  ],
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockStore.clear();
  useQuizProgress.getState().reset();
  setParams({ setId });
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: 'attempt-1' });
  mockApi.quiz.answer.mockResolvedValue({ correct: true, correctAnswer: '정답' });
  await useAuth
    .getState()
    .signIn({ accessToken: 'access', refreshToken: 'refresh' }, { ...seedUser(), _id: 'me' });
  await useAuth.getState().finishOnboarding();
});
afterEach(() => useQuizProgress.getState().reset());

it('문제의 난이도를 진행 줄에 붙이고, 난이도가 없으면 붙이지 않는다', async () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  await renderScreen(<QuizSolveScreen />, qc);
  expect(await screen.findByText('중간 난이도 문제')).toBeTruthy();
  expect(screen.getByText('복습 퀴즈 1 / 2 · 난이도 중')).toBeTruthy();

  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1));
  await fireEvent.press(await screen.findByText('① 정답'));
  await fireEvent.press(await screen.findByText('다음 문제 풀기'));
  expect(await screen.findByText('난이도가 없는 문제')).toBeTruthy();
  expect(screen.getByText('복습 퀴즈 2 / 2')).toBeTruthy();
  qc.clear();
});
