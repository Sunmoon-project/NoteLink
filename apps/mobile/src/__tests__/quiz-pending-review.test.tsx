import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ERROR_CODES } from '@notelink/shared';
import { QuizGenScreen, QuizSolveScreen } from '../features/quiz/quiz';
import { ApiError } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  quiz: { set: jest.fn(), startAttempt: jest.fn(), answer: jest.fn(), createSet: jest.fn() },
  ai: { cancel: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  },
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../lib/socket', () => ({
  socket: { on: jest.fn(() => () => {}), emit: jest.fn() },
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
const setId = 'pending-answer-set';
const attemptId = 'pending-answer-attempt';
const question = {
  _id: 'pending-question',
  type: 'short_answer',
  prompt: '답변 대기를 재현하는 문제',
  choices: null,
  answer: '정답',
};
const quizSet = { _id: setId, questions: [question], questionCount: 1 };
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
  useQuizProgress.getState().reset();
  useAuth.setState({ expired: false });
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: attemptId });
  setParams({ setId });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  useQuizProgress.getState().reset();
});

it('채점 응답 대기 중 화면을 떠났다가 돌아오면 입력을 보존하고 다시 제출할 수 있다', async () => {
  const oldAnswer = deferred<{ correct: boolean; correctAnswer: string }>();
  mockApi.quiz.answer
    .mockReturnValueOnce(oldAnswer.promise)
    .mockResolvedValue({ correct: false, correctAnswer: '정답' });
  const qc = client();
  const first = await renderScreen(<QuizSolveScreen />, qc);
  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1));
  await fireEvent.changeText(
    await screen.findByPlaceholderText('답을 입력해주세요'),
    '저장된 입력',
  );
  await userEvent.setup().press(screen.getByRole('button', { name: '답 제출' }));
  await waitFor(() => expect(mockApi.quiz.answer).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(useQuizProgress.getState().progress).toMatchObject({ pick: '저장된 입력', right: null }),
  );
  await first.unmount();
  try {
    await renderScreen(<QuizSolveScreen />, qc);
    const input = await screen.findByPlaceholderText('답을 입력해주세요');
    expect(input.props.value).toBe('저장된 입력');
    expect(input.props.editable).toBe(true);
    expect(screen.getByRole('button', { name: '답 제출' })).toBeEnabled();
    await fireEvent.changeText(input, '새로 제출한 입력');
    await userEvent.setup().press(screen.getByRole('button', { name: '답 제출' }));
    await waitFor(() =>
      expect(mockApi.quiz.answer).toHaveBeenLastCalledWith(
        attemptId,
        question._id,
        '새로 제출한 입력',
      ),
    );
    await waitFor(() =>
      expect(useQuizProgress.getState().progress).toMatchObject({
        pick: '새로 제출한 입력',
        right: false,
        results: [false],
      }),
    );
    expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      oldAnswer.resolve({ correct: true, correctAnswer: '정답' });
    });
  }
});

it('이전 화면의 늦은 채점 응답은 새 화면에서 저장한 다른 풀이 상태를 덮어쓰지 않는다', async () => {
  const oldAnswer = deferred<{ correct: boolean; correctAnswer: string }>();
  mockApi.quiz.answer.mockReturnValue(oldAnswer.promise);
  const qc = client();
  const first = await renderScreen(<QuizSolveScreen />, qc);
  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1));
  await fireEvent.changeText(
    await screen.findByPlaceholderText('답을 입력해주세요'),
    '이전 화면 답',
  );
  await userEvent.setup().press(screen.getByRole('button', { name: '답 제출' }));
  await waitFor(() => expect(mockApi.quiz.answer).toHaveBeenCalledTimes(1));
  await first.unmount();
  const newerSetId = 'newer-set';
  mockApi.quiz.set.mockResolvedValue({ ...quizSet, _id: newerSetId });
  setParams({ setId: newerSetId });
  await renderScreen(<QuizSolveScreen />, qc);
  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(2));
  await fireEvent.changeText(
    await screen.findByPlaceholderText('답을 입력해주세요'),
    '새 화면에서 쓰는 답',
  );
  await waitFor(() =>
    expect(useQuizProgress.getState().progress).toMatchObject({
      setId: newerSetId,
      answerText: '새 화면에서 쓰는 답',
      pick: null,
    }),
  );
  const newerProgress = useQuizProgress.getState().progress;
  await act(async () => {
    oldAnswer.resolve({ correct: true, correctAnswer: '정답' });
  });
  expect(useQuizProgress.getState().progress).toEqual(newerProgress);
  expect(screen.getByPlaceholderText('답을 입력해주세요').props.value).toBe('새 화면에서 쓰는 답');
  expect(screen.queryByText('정답이에요')).toBeNull();
});

it('세트 생성 전 크레딧 부족으로 거절되면 가짜 생성 결과나 빈 세트 이동을 제공하지 않는다', async () => {
  const message = 'AI 크레딧이 부족해 문제를 생성하지 못했습니다';
  mockApi.quiz.createSet.mockRejectedValue(
    new ApiError(ERROR_CODES.AI_CREDIT_EXHAUSTED, message, 402),
  );
  setParams({ materialId: 'uncreated-material', title: '아직 생성하지 못한 노트' });
  await renderScreen(<QuizGenScreen />, client());
  await waitFor(() => expect(mockApi.quiz.createSet).toHaveBeenCalledTimes(1));
  await act(async () => {});
  expect(screen.queryByText('만든 문제 보기')).toBeNull();
  expect(screen.queryByText(/문제를 3개까지 만들었어요/)).toBeNull();
  expect(await screen.findByText(message)).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalledWith({
    pathname: '/play/solve',
    params: { setId: '' },
  });
});
