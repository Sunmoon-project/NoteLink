import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { AiJob } from '@notelink/shared';
import { QuizGenScreen, QuizHomeScreen, QuizSolveScreen } from '../features/quiz/quiz';
import { useAuth } from '../stores/auth';
import { useQuizProgress, type QuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  quiz: {
    set: jest.fn(),
    sets: jest.fn(),
    startAttempt: jest.fn(),
    finish: jest.fn(),
    createSet: jest.fn(),
  },
  ai: { job: jest.fn(), cancel: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('../lib/socket', () => ({ socket: { on: jest.fn(() => () => {}), emit: jest.fn() } }));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

const setId = 'old-finish-set';
const attemptId = 'old-finish-attempt';
const question = {
  _id: 'question-one',
  type: 'short_answer',
  prompt: '저장한 문제',
  choices: null,
  answer: '정답',
};
const quizSet = {
  _id: setId,
  title: '완료할 퀴즈',
  status: 'ready',
  questionCount: 1,
  questions: [question],
};
const answered: QuizProgress = {
  setId,
  attemptId,
  index: 0,
  answerText: '정답',
  pick: '정답',
  right: true,
  results: [true],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
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
  Object.values(mockApi.quiz).forEach((fn) => fn.mockReset());
  Object.values(mockApi.ai).forEach((fn) => fn.mockReset());
  useQuizProgress.getState().reset();
  useAuth.setState({ userId: 'account-a', expired: false });
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: attemptId });
  setParams({ setId });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  useQuizProgress.getState().reset();
});

async function pendingFinish() {
  const pending = deferred<{ pointsEarned: number; balance: number }>();
  mockApi.quiz.finish.mockReturnValue(pending.promise);
  useQuizProgress.getState().save(answered);
  const view = await renderScreen(<QuizSolveScreen />, client());
  await userEvent.setup().press(await screen.findByRole('button', { name: '다음 문제 풀기' }));
  await waitFor(() => expect(mockApi.quiz.finish).toHaveBeenCalledWith(attemptId));
  return { pending, view };
}

it('완료 응답 전 화면을 떠나 새 풀이를 저장하면 늦은 완료는 새 상태를 지우거나 이동하지 않는다', async () => {
  const { pending, view } = await pendingFinish();
  await view.unmount();
  const newer: QuizProgress = {
    ...answered,
    setId: 'newer-set',
    attemptId: 'newer-attempt',
    answerText: '새 풀이 입력',
    pick: null,
    right: null,
    results: [],
  };
  useQuizProgress.getState().save(newer);
  await act(async () => {
    pending.resolve({ pointsEarned: 120, balance: 120 });
  });
  expect(useQuizProgress.getState().progress).toEqual(newer);
  expect(router.replace).not.toHaveBeenCalled();
});

it('화면이 교체되기 전 다른 계정이 같은 세트·풀이 ID를 저장해도 이전 완료는 무시한다', async () => {
  const { pending } = await pendingFinish();
  const newer: QuizProgress = {
    ...answered,
    answerText: 'B 계정의 입력',
    pick: null,
    right: null,
    results: [],
  };
  await act(async () => {
    useQuizProgress.getState().reset();
    useAuth.setState({ userId: 'account-b' });
    useQuizProgress.getState().save(newer);
    pending.resolve({ pointsEarned: 120, balance: 120 });
  });
  expect(useQuizProgress.getState().progress).toEqual(newer);
  expect(router.replace).not.toHaveBeenCalled();
});

it('같은 계정이라도 진행 상태 reset 후 동일 세트·풀이 ID로 새로 저장하면 이전 완료는 무시한다', async () => {
  const { pending } = await pendingFinish();
  const newer: QuizProgress = {
    ...answered,
    answerText: '초기화 후 새 입력',
    pick: null,
    right: null,
    results: [],
  };
  await act(async () => {
    useQuizProgress.getState().reset();
    useQuizProgress.getState().save(newer);
    pending.resolve({ pointsEarned: 120, balance: 120 });
  });
  expect(useQuizProgress.getState().progress).toEqual(newer);
  expect(router.replace).not.toHaveBeenCalled();
});

const queued: AiJob = {
  _id: 'missed-done-job',
  type: 'quiz_generate',
  status: 'queued',
  targetType: 'quiz_set',
  targetId: setId,
  progress: 0,
  attempts: 1,
  result: null,
  error: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

it('생성 완료 소켓을 놓쳐도 주기적 작업 조회의 succeeded로 준비 화면에 복구한다', async () => {
  mockApi.quiz.createSet.mockResolvedValue({ quizSet, job: queued });
  mockApi.ai.job
    .mockResolvedValueOnce({ ...queued, status: 'running' })
    .mockResolvedValue({ ...queued, status: 'succeeded', progress: 100 });
  setParams({ materialId: 'generation-material', title: '복구할 퀴즈' });
  await renderScreen(<QuizGenScreen />, client());
  await waitFor(() => expect(mockApi.ai.job).toHaveBeenCalledWith(queued._id));
  await waitFor(
    () =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/play/ready',
        params: { setId, title: '복구할 퀴즈' },
      }),
    { timeout: 8000 },
  );
  expect(mockApi.ai.job.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mockApi.quiz.createSet).toHaveBeenCalledTimes(1);
  expect(router.replace).toHaveBeenCalledTimes(1);
});

it('실패 소켓을 놓쳐도 작업 조회의 failed로 오류를 알리고 생성 POST를 자동 재전송하지 않는다', async () => {
  mockApi.quiz.createSet.mockResolvedValue({ quizSet, job: queued });
  mockApi.ai.job
    .mockResolvedValueOnce({ ...queued, status: 'running' })
    .mockResolvedValue({ ...queued, status: 'failed', error: 'MODEL_TIMEOUT' });
  setParams({ materialId: 'failed-material' });
  await renderScreen(<QuizGenScreen />, client());
  await waitFor(() => expect(mockApi.ai.job).toHaveBeenCalledWith(queued._id));
  expect(await screen.findByText('문제를 만들지 못했어요', {}, { timeout: 8000 })).toBeTruthy();
  expect(mockApi.ai.job.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mockApi.quiz.createSet).toHaveBeenCalledTimes(1);
  expect(router.replace).not.toHaveBeenCalled();
});

it('홈 이어서 풀기는 첫 ready 세트 대신 저장된 세트·풀이 ID와 문제 위치를 이어간다', async () => {
  const savedId = 'saved-resume-set';
  const savedAttempt = 'saved-resume-attempt';
  const savedSet = {
    ...quizSet,
    _id: savedId,
    title: '저장한 풀이',
    questionCount: 2,
    questions: [
      { ...question, _id: 'first' },
      { ...question, _id: 'second', prompt: '저장한 두 번째 문제' },
    ],
  };
  mockApi.quiz.sets.mockResolvedValue([
    { ...quizSet, _id: 'unrelated-first', title: '다른 퀴즈' },
    savedSet,
  ]);
  mockApi.quiz.set.mockResolvedValue(savedSet);
  useQuizProgress.getState().save({
    ...answered,
    setId: savedId,
    attemptId: savedAttempt,
    index: 1,
    answerText: '이어서 작성할 답',
    pick: null,
    right: null,
    results: [true],
  });
  const qc = client();
  const home = await renderScreen(<QuizHomeScreen />, qc);
  await fireEvent.press(await screen.findByText('이어서 풀기'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/play/solve', params: { setId: savedId } });
  await home.unmount();
  setParams({ setId: savedId });
  await renderScreen(<QuizSolveScreen />, qc);
  expect(await screen.findByText('저장한 두 번째 문제')).toBeTruthy();
  expect(screen.getByPlaceholderText('답을 입력해주세요').props.value).toBe('이어서 작성할 답');
  expect(useQuizProgress.getState().progress?.attemptId).toBe(savedAttempt);
  expect(mockApi.quiz.startAttempt).not.toHaveBeenCalled();
});
