import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { AppOverlays } from '../components/AppOverlays';
import { LoginScreen } from '../features/auth/auth';
import { QuizSolveScreen } from '../features/quiz/quiz';
import { seedUser } from '../lib/mock/seed';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockStore.delete(key)),
}));
const mockApi = {
  auth: { emailLogin: jest.fn(), socialLogin: jest.fn() },
  quiz: {
    set: jest.fn(),
    startAttempt: jest.fn(),
    answer: jest.fn(),
    finish: jest.fn(),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ disconnectSocket: jest.fn(), socket: { emit: jest.fn() } }));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

const A = { ...seedUser(), _id: 'account-a', nickname: 'A' };
const tokens = { accessToken: 'access-a', refreshToken: 'refresh-a' };
const setId = 'quiz-auth-review';
const attemptId = 'attempt-before-login';
const quizSet = {
  _id: setId,
  questionCount: 2,
  questions: [
    {
      _id: 'first',
      type: 'multiple_choice',
      prompt: '첫 문제',
      choices: ['정답', '오답'],
      answer: '정답',
    },
    {
      _id: 'second',
      type: 'short_answer',
      prompt: '이어 풀 두 번째 문제',
      choices: null,
      answer: '기억할 답',
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
async function signedIn(onboarded = true) {
  await useAuth.getState().signIn(tokens, A);
  if (onboarded) await useAuth.getState().finishOnboarding();
}
async function submitLogin() {
  await fireEvent.press(screen.getByText('이메일로 로그인'));
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'learner@example.com');
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), 'password-a');
  await fireEvent.press(screen.getByText('로그인'));
  await screen.findByRole('button', { name: '로그인' });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  useAuth.setState({
    ready: true,
    tokens: null,
    user: null,
    userId: null,
    onboarded: false,
    expired: false,
  });
  useQuizProgress.getState().reset();
  useToast.getState().hide();
  setParams({ setId });
  mockApi.auth.emailLogin.mockResolvedValue({ user: A, ...tokens });
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: attemptId });
  mockApi.quiz.answer.mockResolvedValue({ correct: true, correctAnswer: '정답' });
  mockApi.quiz.finish.mockResolvedValue({ pointsEarned: 120, balance: 120 });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  useQuizProgress.getState().reset();
});

it('만료 안내→로그인→풀이 재마운트 후 기존 풀이 ID·문제 위치·미제출 답안을 복원한다', async () => {
  await signedIn();
  const qc = client();
  const quiz = await renderScreen(
    <>
      <QuizSolveScreen />
      <AppOverlays />
    </>,
    qc,
  );
  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1));
  await fireEvent.press(await screen.findByText('① 정답'));
  await fireEvent.press(await screen.findByText('다음 문제 풀기'));
  await fireEvent.changeText(await screen.findByPlaceholderText('답을 입력해주세요'), '기억할 답');
  await waitFor(() =>
    expect(useQuizProgress.getState().progress).toMatchObject({
      attemptId,
      index: 1,
      answerText: '기억할 답',
    }),
  );
  await act(async () => useAuth.getState().setExpired(true));
  // 풀이 화면의 로컬 안내 다음에 렌더되는 전역 ExpiredDialog를 누른다.
  const loginButtons = await screen.findAllByText('다시 로그인');
  await fireEvent.press(loginButtons[loginButtons.length - 1]!);
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/login'));
  await quiz.unmount();
  expect(useAuth.getState()).toMatchObject({ userId: A._id, tokens: null, onboarded: true });

  const login = await renderScreen(<LoginScreen />, qc);
  await submitLogin();
  await waitFor(() =>
    expect(router.replace).toHaveBeenLastCalledWith({ pathname: '/play/solve', params: { setId } }),
  );
  await login.unmount();
  setParams({ setId });
  await renderScreen(<QuizSolveScreen />, qc);
  expect(await screen.findByText('이어 풀 두 번째 문제')).toBeTruthy();
  expect(screen.getByText('복습 퀴즈 2 / 2')).toBeTruthy();
  expect(screen.getByPlaceholderText('답을 입력해주세요').props.value).toBe('기억할 답');
  expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText('답 제출'));
  await waitFor(() =>
    expect(mockApi.quiz.answer).toHaveBeenLastCalledWith(attemptId, 'second', '기억할 답'),
  );
  await fireEvent.press(await screen.findByText('다음 문제 풀기'));
  await waitFor(() => expect(mockApi.quiz.finish).toHaveBeenCalledWith(attemptId));
  await waitFor(() => expect(useQuizProgress.getState().progress).toBeNull());
});
