import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { QuizSimilarScreen, QuizSolveScreen } from '../features/quiz/quiz';
import { NetworkError } from '../lib/api';
import { queryClient } from '../lib/query';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  quiz: {
    set: jest.fn(),
    startAttempt: jest.fn(),
    similar: jest.fn(),
    saveFlashcard: jest.fn(),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  NetworkError: class NetworkError extends Error {},
  ApiError: class ApiError extends Error {},
}));
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

const quizSet = {
  _id: 'qs-latest-review',
  questionCount: 1,
  questions: [
    {
      _id: 'q-latest-review',
      type: 'multiple_choice',
      prompt: '재시도 후 불러온 문제',
      choices: ['정답', '다른 답'],
      answer: '정답',
      order: 1,
    },
  ],
};
const generated = {
  ...quizSet,
  questions: [{ ...quizSet.questions[0], prompt: '한 번 생성한 유사 문제' }],
};
const clients: QueryClient[] = [];
function client(automaticQueryRetry = true) {
  const defaults = queryClient.getDefaultOptions();
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        ...defaults.queries,
        ...(automaticQueryRetry ? {} : { retry: false }),
        retryDelay: 0,
        gcTime: Infinity,
        staleTime: 0,
      },
      mutations: { ...defaults.mutations, retryDelay: 0 },
    },
  });
  clients.push(qc);
  return qc;
}
async function startSimilarIfExplicit() {
  // 새 화면은 명시적 생성 버튼, 수정 전 화면은 마운트 즉시 POST를 보낸다.
  const button = screen.queryByText('유사 퀴즈 만들기');
  if (button) await fireEvent.press(button);
  await waitFor(() => expect(mockApi.quiz.similar).toHaveBeenCalled());
}
beforeEach(() => {
  jest.clearAllMocks();
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: 'attempt-latest-review' });
  mockApi.quiz.similar.mockResolvedValue(generated);
  setParams({ setId: quizSet._id });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
});

it('퀴즈 조회 실패를 안내하고 다시 시도하면 같은 퀴즈를 불러온다', async () => {
  mockApi.quiz.set.mockRejectedValueOnce(new Error('조회 실패')).mockResolvedValue(quizSet);
  await renderScreen(<QuizSolveScreen />, client(false));
  expect(await screen.findByText('퀴즈를 불러오지 못했어요')).toBeTruthy();
  expect(mockApi.quiz.startAttempt).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('다시 시도'));
  expect(await screen.findByText(quizSet.questions[0]!.prompt)).toBeTruthy();
  await waitFor(() => expect(mockApi.quiz.set).toHaveBeenCalledTimes(2));
  expect(mockApi.quiz.set).toHaveBeenLastCalledWith(quizSet._id);
});

it('유사 퀴즈 생성은 사용자가 누르기 전에는 POST를 보내지 않는다', async () => {
  await renderScreen(<QuizSimilarScreen />, client());
  await act(async () => {});
  expect(mockApi.quiz.similar).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
  expect(await screen.findByText('한 번 생성한 유사 문제')).toBeTruthy();
  expect(mockApi.quiz.similar).toHaveBeenCalledTimes(1);
});

it('응답이 유실된 유사 퀴즈 POST는 전역 재시도 정책이 있어도 자동 재전송하지 않는다', async () => {
  mockApi.quiz.similar.mockRejectedValue(new NetworkError('서버 처리 후 응답 유실'));
  const qc = client();
  await renderScreen(<QuizSimilarScreen />, qc);
  await startSimilarIfExplicit();
  await waitFor(() => {
    expect(qc.isFetching()).toBe(0);
    expect(qc.isMutating()).toBe(0);
  });
  expect(mockApi.quiz.similar).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('다시 시도')).toBeTruthy();
});

it('성공한 유사 퀴즈 결과는 오래된 캐시로 재마운트해도 POST를 다시 보내지 않는다', async () => {
  const qc = client();
  const first = await renderScreen(<QuizSimilarScreen />, qc);
  await startSimilarIfExplicit();
  expect(await screen.findByText('한 번 생성한 유사 문제')).toBeTruthy();
  await first.unmount();
  await renderScreen(<QuizSimilarScreen />, qc);
  expect(await screen.findByText('한 번 생성한 유사 문제')).toBeTruthy();
  await waitFor(() => {
    expect(qc.isFetching()).toBe(0);
    expect(qc.isMutating()).toBe(0);
  });
  expect(mockApi.quiz.similar).toHaveBeenCalledTimes(1);
});
