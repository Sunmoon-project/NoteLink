import { act, screen, userEvent, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { QuizSolveScreen } from '../features/quiz/quiz';
import { useAuth } from '../stores/auth';
import { useQuizProgress, type QuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

const mockApi = { quiz: { set: jest.fn(), startAttempt: jest.fn(), finish: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

const setId = 'screen-a-set';
const attemptId = 'screen-a-attempt';
const progressA: QuizProgress = {
  setId,
  attemptId,
  index: 0,
  answerText: '정답',
  pick: '정답',
  right: true,
  results: [true],
};
const quizSet = {
  _id: setId,
  title: 'A 화면 퀴즈',
  status: 'ready',
  questionCount: 1,
  questions: [
    {
      _id: 'last-a-question',
      type: 'short_answer',
      prompt: 'A의 마지막 문제',
      choices: null,
      answer: '정답',
    },
  ],
};
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(qc);
  return qc;
}
beforeEach(() => {
  jest.clearAllMocks();
  useAuth.setState({ userId: 'finish-review-user', expired: false });
  useQuizProgress.getState().reset();
  useQuizProgress.getState().save(progressA);
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.finish.mockResolvedValue({ pointsEarned: 120, balance: 120 });
  setParams({ setId });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  useQuizProgress.getState().reset();
});

it.each([
  { label: '세트와 풀이 ID가 모두 다른 B', nextSet: 'set-b', nextAttempt: 'attempt-b' },
  { label: '같은 세트의 다른 풀이 B', nextSet: setId, nextAttempt: 'attempt-b' },
  { label: '다른 세트지만 풀이 ID가 같은 B', nextSet: 'set-b', nextAttempt: attemptId },
])(
  '$label가 전역 진행을 대체하면 스택의 A 화면은 완료 요청·삭제·이동을 실행하지 않는다',
  async ({ nextSet, nextAttempt }) => {
    await renderScreen(<QuizSolveScreen />, client());
    const finish = await screen.findByRole('button', { name: '다음 문제 풀기' });
    const progressB: QuizProgress = {
      ...progressA,
      setId: nextSet,
      attemptId: nextAttempt,
      answerText: 'B의 보존할 입력',
      pick: null,
      right: null,
      results: [],
    };
    await act(async () => {
      useQuizProgress.getState().save(progressB);
    });
    await userEvent.setup().press(finish);
    await act(async () => {});
    expect(mockApi.quiz.finish).not.toHaveBeenCalled();
    expect(useQuizProgress.getState().progress).toEqual(progressB);
    expect(router.replace).not.toHaveBeenCalled();
  },
);

it('화면과 저장 상태의 세트·풀이 ID가 일치하면 화면의 풀이 ID만 완료하고 결과로 이동한다', async () => {
  await renderScreen(<QuizSolveScreen />, client());
  await userEvent.setup().press(await screen.findByRole('button', { name: '다음 문제 풀기' }));
  await waitFor(() => expect(mockApi.quiz.finish).toHaveBeenCalledWith(attemptId));
  expect(mockApi.quiz.finish).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/play/review',
      params: { setId, points: '120' },
    }),
  );
  expect(useQuizProgress.getState().progress).toBeNull();
});
