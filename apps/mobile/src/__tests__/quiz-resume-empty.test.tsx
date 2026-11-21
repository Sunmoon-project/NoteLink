import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { QuizSet } from '@notelink/shared';
import { QuizHomeScreen, QuizSolveScreen } from '../features/quiz/quiz';
import { queryClient } from '../lib/query';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

// #630 (TestQA QUIZ-011): 세트에 들어갔다 답 없이 나와도 퀴즈 탭 맨 위 카드에 「이어서 풀기」로 뜨던 문제.
// 진행은 첫 답을 낸 뒤부터 저장하고, 맨 위 카드는 답한 문제가 없는 진행을 무시한다
const mockApi = {
  quiz: {
    sets: jest.fn(),
    today: jest.fn(),
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
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
jest.mock('expo-haptics', () => ({ notificationAsync: jest.fn(), NotificationFeedbackType: {} }));

const quizSet = (_id: string, title: string, over: Partial<QuizSet> = {}) =>
  ({
    _id,
    title,
    status: 'ready',
    questionCount: 2,
    questions: [1, 2].map((n) => ({
      _id: `${_id}-q${n}`,
      order: n,
      type: 'multiple_choice',
      prompt: `${title} 문제 ${n}`,
      choices: ['답', '오답'],
      answer: '답',
      explanation: null,
      conceptTags: [],
    })),
    ...over,
  }) as QuizSet;

const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(qc);
  return qc;
};

beforeEach(() => {
  jest.clearAllMocks();
  useQuizProgress.getState().reset();
  useAuth.setState({ userId: 'owner', expired: false });
  mockApi.quiz.today.mockResolvedValue(null);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: 'attempt-1' });
  mockApi.quiz.answer.mockResolvedValue({ correct: true, correctAnswer: '답' });
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  queryClient.clear();
  useQuizProgress.getState().reset();
});

/** 풀기 화면에 들어가 풀이가 시작될 때까지 기다린다(첫 문제가 보이고 서버 풀이가 생김) */
async function enter(set: QuizSet) {
  setParams({ setId: set._id });
  mockApi.quiz.set.mockResolvedValue(set);
  const view = await renderScreen(<QuizSolveScreen />, client());
  expect(await screen.findByText(`${set.title} 문제 1`)).toBeTruthy();
  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledWith(set._id));
  return view;
}

/** 퀴즈 탭을 그린다. 서버는 들어간 세트를 started로 알려 준다 */
async function home(sets: QuizSet[]) {
  setParams({});
  mockApi.quiz.sets.mockResolvedValue(sets);
  await renderScreen(<QuizHomeScreen />, client());
}

it.each([
  ['맞춤 퀴즈', {}],
  ['유사 퀴즈', { sourceSetId: 'origin' }],
  ['오늘의 복습', { reviewDay: '2026-11-22' }],
] as const)('%s 세트에 들어갔다 답 없이 나오면 이어서 풀기가 뜨지 않는다', async (title, over) => {
  const seen = quizSet('seen', `본 ${title}`, over);
  const view = await enter(seen);
  await view.unmount();
  expect(useQuizProgress.getState().progress).toBeNull();

  await home([{ ...seen, started: true }, quizSet('fresh', '새 퀴즈')]);
  expect(await screen.findByText('새 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.getByText('퀴즈 풀기')).toBeTruthy();
  expect(screen.queryByText('이어서 풀기')).toBeNull();
  expect(screen.queryByText(`본 ${title} · 2문제`)).toBeNull();
});

it('1문제 답하고 나오면 그 세트를 이어서 풀기로 보여 준다', async () => {
  const seen = quizSet('seen', '본 퀴즈');
  const view = await enter(seen);
  await fireEvent.press(screen.getByText('① 답'));
  await waitFor(() =>
    expect(useQuizProgress.getState().progress).toMatchObject({
      setId: 'seen',
      attemptId: 'attempt-1',
      results: [true],
    }),
  );
  await view.unmount();

  await home([{ ...seen, started: true }, quizSet('fresh', '새 퀴즈')]);
  expect(await screen.findByText('본 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.getByText('이어서 풀기')).toBeTruthy();
  expect(screen.queryByText('새 퀴즈 · 2문제')).toBeNull();
});

it('첫 답의 채점이 실패하면 그 답을 내며 저장한 진행을 지운다', async () => {
  mockApi.quiz.answer.mockRejectedValueOnce(new Error('network'));
  const seen = quizSet('seen', '본 퀴즈');
  const view = await enter(seen);
  await fireEvent.press(screen.getByText('① 답'));
  await waitFor(() => expect(mockApi.quiz.answer).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useQuizProgress.getState().progress).toBeNull());
  await view.unmount();

  await home([{ ...seen, started: true }, quizSet('fresh', '새 퀴즈')]);
  expect(await screen.findByText('새 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.queryByText('이어서 풀기')).toBeNull();
});

it('첫 문제에서 로그인이 만료되면 답이 없어도 세트 · 입력한 답을 남긴다(다시 로그인하면 돌아옴)', async () => {
  const typed = quizSet('typed', '주관식 퀴즈');
  typed.questions = typed.questions.map((q) => ({ ...q, type: 'short_answer', choices: null }));
  // 다른 세트를 풀던 진행이 있어도, 만료되면 지금 보던 세트로 돌아오게 덮는다
  useQuizProgress.getState().save({
    setId: 'other',
    attemptId: 'attempt-other',
    index: 1,
    answerText: '',
    pick: null,
    right: null,
    results: [true],
  });
  await enter(typed);
  await fireEvent.changeText(screen.getByPlaceholderText('답을 입력해주세요'), '쓰던 답');
  await act(async () => useAuth.getState().setExpired(true));
  await waitFor(() =>
    expect(useQuizProgress.getState().progress).toMatchObject({
      setId: 'typed',
      attemptId: 'attempt-1',
      index: 0,
      answerText: '쓰던 답',
      results: [],
    }),
  );
});

it('문제 없는 세트에서 돌아가도 다른 세트를 풀던 진행은 지우지 않는다', async () => {
  const resume = {
    setId: 'other',
    attemptId: 'attempt-other',
    index: 1,
    answerText: '',
    pick: null,
    right: null,
    results: [true],
  };
  useQuizProgress.getState().save(resume);
  setParams({ setId: 'empty' });
  mockApi.quiz.set.mockResolvedValue({ ...quizSet('empty', '빈 퀴즈'), questions: [] });
  await renderScreen(<QuizSolveScreen />, client());
  await fireEvent.press(await screen.findByText('돌아가기'));
  expect(useQuizProgress.getState().progress).toMatchObject(resume);
});

// 진행은 메모리라 고치기 전 앱이 남긴 빈 진행은 앱을 다시 켜면 사라진다. 지금도 로그인 만료 때는 답 없는 진행을
// 남기므로(위 시험), 맨 위 카드는 답한 문제가 없는 진행을 거른다
it('답 없는 진행(예전에 들어가기만 해도 남던 것 · 로그인 만료 때 남긴 것)은 무시하고 안 푼 세트를 보여 준다', async () => {
  useQuizProgress.getState().save({
    setId: 'seen',
    attemptId: 'attempt-old',
    index: 0,
    answerText: '',
    pick: null,
    right: null,
    results: [],
  });
  await home([quizSet('seen', '본 퀴즈', { started: true }), quizSet('fresh', '새 퀴즈')]);
  expect(await screen.findByText('새 퀴즈 · 2문제')).toBeTruthy();
  expect(screen.getByText('퀴즈 풀기')).toBeTruthy();
  expect(screen.queryByText('이어서 풀기')).toBeNull();
  expect(screen.queryByText('풀던 퀴즈')).toBeNull();
});
