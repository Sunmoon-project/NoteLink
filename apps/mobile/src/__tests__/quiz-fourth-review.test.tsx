import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { QuizSolveScreen } from '../features/quiz/quiz';
import { useAuth } from '../stores/auth';
import { useQuizProgress, type QuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

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
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
// 오답 노트(기기 파일)는 부르는지만 본다
const mockRecordWrong = jest.fn();
jest.mock('../features/quiz/wrong-review', () => ({
  recordWrong: (...a: unknown[]) => mockRecordWrong(...a),
}));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

const setId = 'fourth-screen-a';
const attemptId = 'fourth-attempt-a';
const question = {
  _id: 'first-a',
  type: 'short_answer',
  prompt: 'A 첫 번째 문제',
  choices: null,
  answer: '정답',
};
const quizSet = {
  _id: setId,
  title: 'A 세트',
  status: 'ready',
  questionCount: 2,
  questions: [question, { ...question, _id: 'last-a', prompt: 'A 마지막 문제' }],
};
const progressA: QuizProgress = {
  setId,
  attemptId,
  index: 0,
  answerText: '정답',
  pick: '정답',
  right: true,
  results: [true],
};
const progressB: QuizProgress = {
  setId: 'fourth-screen-b',
  attemptId: 'fourth-attempt-b',
  index: 0,
  answerText: 'B의 보존할 입력',
  pick: null,
  right: null,
  results: [],
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.values(mockApi.quiz).forEach((fn) => fn.mockReset());
  useAuth.setState({ userId: 'fourth-review-user', expired: false });
  useQuizProgress.getState().reset();
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: attemptId });
  mockApi.quiz.answer.mockResolvedValue({ correct: true, correctAnswer: '정답' });
  setParams({ setId });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  useQuizProgress.getState().reset();
});
async function saveB() {
  await act(async () => {
    useQuizProgress.getState().save(progressB);
  });
}

it('중간 문제의 A 화면에서 B 진행 저장 후 다음 문제를 눌러도 B 진행을 덮어쓰지 않는다', async () => {
  useQuizProgress.getState().save(progressA);
  await renderScreen(<QuizSolveScreen />, client());
  const next = await screen.findByRole('button', { name: '다음 문제 풀기' });
  await saveB();
  await userEvent.setup().press(next);
  expect(useQuizProgress.getState().progress).toEqual(progressB);
  expect(mockApi.quiz.finish).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});

it('A 오답 화면에서 다시 풀기를 눌러도 새로 저장된 B 진행을 덮어쓰지 않는다', async () => {
  useQuizProgress.getState().save({ ...progressA, pick: '오답', right: false, results: [false] });
  await renderScreen(<QuizSolveScreen />, client());
  const retry = await screen.findByRole('button', { name: '다시 풀기' });
  await saveB();
  await userEvent.setup().press(retry);
  expect(useQuizProgress.getState().progress).toEqual(progressB);
});

it('소유권을 잃은 A 화면의 답안 입력·제출은 B 진행을 덮거나 A 답안을 전송하지 않는다', async () => {
  useQuizProgress
    .getState()
    .save({ ...progressA, answerText: '', pick: null, right: null, results: [] });
  await renderScreen(<QuizSolveScreen />, client());
  const input = await screen.findByPlaceholderText('답을 입력해주세요');
  await saveB();
  await fireEvent.changeText(input, '이미 지난 A 화면의 입력');
  expect(useQuizProgress.getState().progress).toEqual(progressB);
  await userEvent.setup().press(screen.getByRole('button', { name: '답 제출' }));
  expect(mockApi.quiz.answer).not.toHaveBeenCalled();
});

it('A 화면 채점 대기 중 B 진행이 저장되면 늦은 채점 응답도 B 진행을 보존한다', async () => {
  const pending = deferred<{ correct: boolean; correctAnswer: string }>();
  mockApi.quiz.answer.mockReturnValue(pending.promise);
  useQuizProgress
    .getState()
    .save({ ...progressA, answerText: 'A 입력', pick: null, right: null, results: [] });
  await renderScreen(<QuizSolveScreen />, client());
  await userEvent.setup().press(await screen.findByRole('button', { name: '답 제출' }));
  await waitFor(() => expect(mockApi.quiz.answer).toHaveBeenCalledTimes(1));
  await saveB();
  await act(async () => {
    pending.resolve({ correct: true, correctAnswer: '정답' });
  });
  expect(useQuizProgress.getState().progress).toEqual(progressB);
});

it('A 세트 재조회 응답이 새 객체로 바뀌어도 전역 B 진행을 덮어쓰지 않는다', async () => {
  useQuizProgress.getState().save(progressA);
  const qc = client();
  await renderScreen(<QuizSolveScreen />, qc);
  await screen.findByRole('button', { name: '다음 문제 풀기' });
  await saveB();
  mockApi.quiz.set.mockResolvedValue({ ...quizSet, title: '외부에서 재조회한 A 세트' });
  await act(async () => {
    await qc.refetchQueries({ queryKey: ['quiz-set', setId] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(useQuizProgress.getState().progress).toEqual(progressB);
});

it('A 시작 요청 대기 중 B 진행이 저장되면 늦은 attemptId 응답이 B를 덮어쓰지 않는다', async () => {
  const pending = deferred<{ _id: string }>();
  mockApi.quiz.startAttempt.mockReturnValue(pending.promise);
  await renderScreen(<QuizSolveScreen />, client());
  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1));
  await saveB();
  await act(async () => {
    pending.resolve({ _id: attemptId });
  });
  expect(useQuizProgress.getState().progress).toEqual(progressB);
});

it('완료 대기 중 동일 풀이의 저장·재조회로 객체만 바뀌면 정상 완료를 계속 처리한다', async () => {
  const pending = deferred<{ pointsEarned: number; balance: number }>();
  mockApi.quiz.finish.mockReturnValue(pending.promise);
  useQuizProgress.getState().save({ ...progressA, index: 1, results: [true, true] });
  const qc = client();
  await renderScreen(<QuizSolveScreen />, qc);
  await userEvent.setup().press(await screen.findByRole('button', { name: '다음 문제 풀기' }));
  await waitFor(() => expect(mockApi.quiz.finish).toHaveBeenCalledWith(attemptId));
  await act(async () => {
    const current = useQuizProgress.getState().progress!;
    useQuizProgress.getState().save({ ...current });
    mockApi.quiz.set.mockResolvedValue({ ...quizSet, title: '같은 풀이의 최신 조회' });
    await qc.refetchQueries({ queryKey: ['quiz-set', setId] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending.resolve({ pointsEarned: 120, balance: 120 });
  });
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/play/review',
      params: { setId, points: '120' },
    }),
  );
  expect(useQuizProgress.getState().progress).toBeNull();
});

it('틀린 문제는 오답 노트에 넣고, 다시 풀기로 맞혀도 빼지 않는다(오답 복습에서 맞혀야 빠짐)', async () => {
  mockApi.quiz.answer
    .mockResolvedValueOnce({ correct: false, correctAnswer: '정답' })
    .mockResolvedValueOnce({ correct: true, correctAnswer: '정답' });
  await renderScreen(<QuizSolveScreen />, client());
  const input = await screen.findByPlaceholderText('답을 입력해주세요');
  await fireEvent.changeText(input, '오답');
  await fireEvent.press(screen.getByText('답 제출'));
  await waitFor(() =>
    expect(mockRecordWrong).toHaveBeenCalledWith('fourth-review-user', question, 'A 세트'),
  );
  await fireEvent.press(await screen.findByRole('button', { name: '다시 풀기' }));
  await fireEvent.changeText(await screen.findByPlaceholderText('답을 입력해주세요'), '정답');
  await fireEvent.press(screen.getByText('답 제출'));
  await waitFor(() => expect(mockApi.quiz.answer).toHaveBeenCalledTimes(2));
  expect(mockRecordWrong).toHaveBeenCalledTimes(1);
});
