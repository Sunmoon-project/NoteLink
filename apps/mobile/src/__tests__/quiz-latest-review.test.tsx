import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { QuizSimilarScreen, QuizSolveScreen } from '../features/quiz/quiz';
import { NetworkError } from '../lib/api';
import { queryClient } from '../lib/query';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  quiz: {
    set: jest.fn(),
    startAttempt: jest.fn(),
    similar: jest.fn(),
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
  _id: 'similar-ready',
  status: 'ready',
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
/** 다 만든 유사 퀴즈는 일반 퀴즈처럼 풀이 화면으로 바로 넘어간다 */
const toSolve = (setId: string) =>
  waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/play/solve', params: { setId } }),
  );
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
  await toSolve('similar-ready');
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

it('다 만든 유사 퀴즈는 풀이 화면으로 한 번만 넘기고 POST를 다시 보내지 않는다', async () => {
  const qc = client();
  await renderScreen(<QuizSimilarScreen />, qc);
  await startSimilarIfExplicit();
  await toSolve('similar-ready');
  await waitFor(() => {
    expect(qc.isFetching()).toBe(0);
    expect(qc.isMutating()).toBe(0);
  });
  expect(router.replace).toHaveBeenCalledTimes(1);
  expect(mockApi.quiz.similar).toHaveBeenCalledTimes(1);
  // 문제를 이 화면에 늘어놓지 않는다(풀이 화면에서 푼다)
  expect(screen.queryByText('한 번 생성한 유사 문제')).toBeNull();
});

it('서버가 「다시 보기」 세트를 만드는 중으로 주면 다 만들 때까지 세트를 다시 읽고 풀이 화면으로 넘어간다', async () => {
  const making = {
    ...generated,
    _id: 'similar-set',
    status: 'generating',
    progress: 40,
    questions: [],
  };
  mockApi.quiz.similar.mockResolvedValue(making);
  mockApi.quiz.set
    .mockResolvedValueOnce(making)
    .mockResolvedValue({ ...generated, _id: 'similar-set', status: 'ready' });
  await renderScreen(<QuizSimilarScreen />, client());
  await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
  expect(await screen.findByText(/비슷한 문제를 만들고 있어요/)).toBeTruthy();
  await waitFor(
    () =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/play/solve',
        params: { setId: 'similar-set' },
      }),
    { timeout: 5000 },
  );
  expect(mockApi.quiz.set).toHaveBeenCalledWith('similar-set');
  expect(mockApi.quiz.similar).toHaveBeenCalledTimes(1);
});

it('만들기가 실패하면(failed) 기다리기를 멈추고 다시 시도를 보여 준다', async () => {
  const making = { ...generated, _id: 'similar-set', status: 'generating', questions: [] };
  mockApi.quiz.similar.mockResolvedValue(making);
  mockApi.quiz.set.mockResolvedValue({ ...making, status: 'failed' });
  await renderScreen(<QuizSimilarScreen />, client());
  await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
  expect(await screen.findByText('다시 시도')).toBeTruthy();
  expect(screen.getByText('생성 결과를 받지 못했어요. 다시 시도하면 새로 만들어요.')).toBeTruthy();
});

it('유사 퀴즈 요청이 바로 실패한 세트를 돌려주면 확인 대신 다시 시도를 보여 준다', async () => {
  mockApi.quiz.similar.mockResolvedValue({ ...generated, status: 'failed', questions: [] });
  await renderScreen(<QuizSimilarScreen />, client());
  await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
  expect(await screen.findByText('다시 시도')).toBeTruthy();
  expect(screen.queryByText('확인')).toBeNull();
});

it('만든 결과 조회가 계속 실패하면 알리고, 다시 확인으로 다시 읽는다', async () => {
  const making = { ...generated, _id: 'similar-set', status: 'generating', questions: [] };
  mockApi.quiz.similar.mockResolvedValue(making);
  mockApi.quiz.set.mockRejectedValue(new NetworkError('연결 끊김'));
  await renderScreen(<QuizSimilarScreen />, client(false));
  await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
  expect(await screen.findByText(/만든 결과를 확인하지 못했어요/)).toBeTruthy();
  mockApi.quiz.set.mockResolvedValue({ ...generated, _id: 'similar-set', status: 'ready' });
  await fireEvent.press(screen.getByText('다시 확인'));
  await toSolve('similar-set');
  expect(mockApi.quiz.similar).toHaveBeenCalledTimes(1);
});

it('만드는 중을 한 번 받은 뒤 조회가 계속 실패해도 알리고 다시 확인할 수 있다', async () => {
  const making = { ...generated, _id: 'similar-set', status: 'generating', questions: [] };
  mockApi.quiz.similar.mockResolvedValue(making);
  mockApi.quiz.set.mockResolvedValueOnce(making).mockRejectedValue(new NetworkError('연결 끊김'));
  await renderScreen(<QuizSimilarScreen />, client(false));
  await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
  expect(await screen.findByText(/비슷한 문제를 만들고 있어요/)).toBeTruthy();
  expect(
    await screen.findByText(/만든 결과를 확인하지 못했어요/, {}, { timeout: 5000 }),
  ).toBeTruthy();
  mockApi.quiz.set.mockResolvedValue({ ...generated, _id: 'similar-set', status: 'ready' });
  await fireEvent.press(screen.getByText('다시 확인'));
  await toSolve('similar-set');
});
