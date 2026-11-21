// 퀴즈 결과 화면의 「다음 단계」 카드(FR-37, 퀴즈 → 복습 이어 주기).
// 서버가 복습 일정에 넣은 수(scheduled) · 날짜(nextReviewDay)를 돌려주면 그대로 보이고, 틀린 문제는 비슷한 문제 복습으로 잇는다
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { QuizReviewScreen, QuizSolveScreen } from '../features/quiz/quiz';
import { addDays, parse, today, ymd } from '../lib/dates';
import { queryClient } from '../lib/query';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  quiz: {
    set: jest.fn(),
    startAttempt: jest.fn(),
    answer: jest.fn(),
    finish: jest.fn(),
    saveToBox: jest.fn(),
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

const q = (n: number) => ({
  _id: `q${n}`,
  type: 'multiple_choice',
  order: n,
  prompt: `문제 ${n}`,
  choices: ['답', '오답'],
  answer: '답',
});
const quizSet = { _id: 'set-1', questionCount: 2, questions: [q(1), q(2)] };
const tomorrow = ymd(addDays(parse(today()), 1));
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

beforeEach(() => {
  jest.clearAllMocks();
  useQuizProgress.getState().reset();
  useAuth.setState({ userId: 'owner', expired: false });
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: 'attempt-1' });
  mockApi.quiz.answer.mockResolvedValue({ correct: true, correctAnswer: '답' });
  mockApi.quiz.saveToBox.mockResolvedValue([]);
});
afterEach(() => {
  queryClient.clear();
  useQuizProgress.getState().reset();
});

it('다 풀면 서버가 복습 일정에 넣은 수와 날짜를 결과 화면에 넘긴다', async () => {
  mockApi.quiz.set.mockResolvedValue({ ...quizSet, questionCount: 1, questions: [q(1)] });
  mockApi.quiz.finish.mockResolvedValue({
    pointsEarned: 4,
    balance: 4,
    scheduled: 1,
    nextReviewDay: tomorrow,
  });
  setParams({ setId: quizSet._id });
  await renderScreen(<QuizSolveScreen />, client());
  await fireEvent.press(await screen.findByText('① 답'));
  await fireEvent.press(await screen.findByRole('button', { name: '다음 문제 풀기' }));
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/play/review',
      params: {
        setId: quizSet._id,
        points: '4',
        results: '1',
        scheduled: '1',
        nextReviewDay: tomorrow,
      },
    }),
  );
});

it('틀린 문제가 있으면 복습 날짜를 알려 주고, 비슷한 문제 복습 · 새 퀴즈로 잇는다', async () => {
  setParams({ setId: quizSet._id, results: '10', scheduled: '2', nextReviewDay: tomorrow });
  await renderScreen(<QuizReviewScreen />, client());

  expect(await screen.findByText('복습할 문제는 내일 다시 물어볼게요')).toBeTruthy();
  expect(screen.getByText(/^복습 일정에 넣었어요 · 다음 복습/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: /틀린 1문제 비슷한 문제로 지금 복습/ }));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/similar',
    params: { setId: quizSet._id },
  });
  await fireEvent.press(screen.getByRole('button', { name: /다른 노트로 새 퀴즈/ }));
  expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/quiz/notes');
  // 예전 작은 「유사 퀴즈 생성하기」 글 버튼은 카드로 옮겼다
  expect(screen.queryByText('유사 퀴즈 생성하기')).toBeNull();
});

// #625: 퀴즈를 끝내도 유사 퀴즈를 저절로 만들지 않는다. 노트 폴더가 있는 세트는 고르기 화면(#610, 틀린 문제를 처음부터
// 체크)으로 보내고, 오늘의 복습 · 폴더가 없는 옛 세트만 그 세트로 만든다(위 시험)
it('노트 폴더가 있는 세트는 「비슷한 문제로 지금 복습」을 그 노트의 고르기 화면으로 연다', async () => {
  mockApi.quiz.set.mockResolvedValue({ ...quizSet, materialId: 'note-1', folderId: 'folder-1' });
  setParams({ setId: quizSet._id, results: '10' });
  await renderScreen(<QuizReviewScreen />, client());

  await fireEvent.press(
    await screen.findByRole('button', { name: /틀린 1문제 비슷한 문제로 지금 복습/ }),
  );
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/similar',
    params: { folderId: 'folder-1' },
  });
});

it('오늘의 복습 세트는 폴더가 있어도 그 세트로 유사 퀴즈를 만든다(고르기 화면은 오늘의 복습을 보이지 않음)', async () => {
  mockApi.quiz.set.mockResolvedValue({
    ...quizSet,
    materialId: 'note-1',
    folderId: 'folder-1',
    reviewDay: '2026-11-21',
  });
  setParams({ setId: quizSet._id, results: '10' });
  await renderScreen(<QuizReviewScreen />, client());

  await fireEvent.press(
    await screen.findByRole('button', { name: /틀린 1문제 비슷한 문제로 지금 복습/ }),
  );
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/similar',
    params: { setId: quizSet._id },
  });
});

// Codex 3차: 원본 세트가 있는 세트(오늘의 복습 · 다른 세트에서 이어 만든 유사 퀴즈 · 다시 보기)는 고르기 화면으로 보내면
// 앱의 고르기 생성이 원본 연결 없이 만들어 오늘의 복습 계보(폴더 삭제 보호)가 끊긴다. 서버가 원본을 남기는 세트 경로로
it('원본 세트가 있는 세트(이어 만든 세트)는 폴더가 있어도 그 세트로 유사 퀴즈를 만든다', async () => {
  mockApi.quiz.set.mockResolvedValue({
    ...quizSet,
    materialId: 'note-1',
    folderId: 'folder-1',
    sourceSetId: 'today-set',
  });
  setParams({ setId: quizSet._id, results: '10' });
  await renderScreen(<QuizReviewScreen />, client());

  await fireEvent.press(
    await screen.findByRole('button', { name: /틀린 1문제 비슷한 문제로 지금 복습/ }),
  );
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/similar',
    params: { setId: quizSet._id },
  });
});

it('다 맞혔으면 다음 복습 날짜만 알려 주고, 비슷한 문제 복습은 내지 않는다', async () => {
  setParams({ setId: quizSet._id, results: '11', scheduled: '2', nextReviewDay: tomorrow });
  await renderScreen(<QuizReviewScreen />, client());

  expect(await screen.findByText('다 맞혔어요! 내일 한 번 더 확인해요')).toBeTruthy();
  expect(screen.getByText(/^복습 일정에 넣었어요/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /비슷한 문제/ })).toBeNull();
  expect(screen.getByRole('button', { name: /다른 노트로 새 퀴즈/ })).toBeTruthy();
});

it('복습 일정에 새로 넣지 않았으면(오늘의 복습 · 기기 저장) 날짜를 말하지 않는다', async () => {
  setParams({ setId: quizSet._id, results: '10' });
  await renderScreen(<QuizReviewScreen />, client());

  expect(await screen.findByText('틀린 1문제, 비슷한 문제로 한 번 더 풀어 봐요')).toBeTruthy();
  expect(screen.queryByText(/복습 일정에 넣었어요/)).toBeNull();
  expect(screen.getByRole('button', { name: /틀린 1문제 비슷한 문제로 지금 복습/ })).toBeTruthy();
});

it('스터디룸에서 연 결과는 새 퀴즈로 보내지 않는다', async () => {
  setParams({ setId: quizSet._id, results: '10', from: 'room' });
  await renderScreen(<QuizReviewScreen />, client());

  expect(await screen.findByRole('button', { name: /비슷한 문제로 지금 복습/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /다른 노트로 새 퀴즈/ })).toBeNull();
});
