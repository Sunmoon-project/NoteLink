import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  QuizSolveScreen,
  QuizExplainScreen,
  QuizReviewScreen,
  QuizBoxScreen,
} from '../features/quiz/quiz';
import { queryClient } from '../lib/query';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  quiz: {
    set: jest.fn(),
    startAttempt: jest.fn(),
    answer: jest.fn(),
    finish: jest.fn(),
    box: jest.fn(),
    saveToBox: jest.fn(),
    deleteFromBox: jest.fn(),
    explanation: jest.fn(),
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
const question = {
  _id: 'box-q1',
  type: 'multiple_choice',
  order: 1,
  prompt: '복구와 보관을 확인하는 문제',
  choices: ['답', '오답'],
  answer: '답',
};
const quizSet = { _id: 'box-set', questionCount: 1, questions: [question] };
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(qc);
  return qc;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
beforeEach(() => {
  jest.clearAllMocks();
  useQuizProgress.getState().reset();
  useAuth.setState({ userId: 'owner', expired: false });
  useToast.setState({ msg: null });
  setParams({ setId: quizSet._id });
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: 'box-attempt' });
  mockApi.quiz.answer.mockResolvedValue({ correct: true, correctAnswer: '답' });
  mockApi.quiz.finish.mockResolvedValue({ pointsEarned: 120, balance: 120 });
  mockApi.quiz.box.mockResolvedValue([question]);
  mockApi.quiz.explanation.mockResolvedValue({ text: '실제 문제 해설' });
  mockApi.quiz.saveToBox.mockResolvedValue([question]);
  mockApi.quiz.deleteFromBox.mockResolvedValue(undefined);
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  queryClient.clear();
  useQuizProgress.getState().reset();
});
// #593: 풀기 화면에 들어가면 서버가 그 세트를 started로 알려 주므로, 퀴즈 탭 맨 위 카드가 돌아오자마자
// 들어간 「다시 보기」 세트를 빼게 목록을 다시 읽는다
it('풀기 화면에 들어가 풀이를 시작하면 퀴즈 목록을 다시 읽는다(#593)', async () => {
  queryClient.setQueryData(['quiz-sets'], [quizSet]);
  await renderScreen(<QuizSolveScreen />, client());
  await waitFor(() => expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(queryClient.getQueryState(['quiz-sets'])?.isInvalidated).toBe(true));
});
async function submit() {
  await fireEvent.press(await screen.findByText('① 답'));
  await fireEvent.press(await screen.findByRole('button', { name: '다음 문제 풀기' }));
  await waitFor(() => expect(mockApi.quiz.finish).toHaveBeenCalledTimes(1));
}
it('스터디룸에서 퀴즈를 마치면 결과 화면에도 복귀 경로를 유지한다', async () => {
  setParams({ setId: quizSet._id, from: 'room' });
  await renderScreen(<QuizSolveScreen />, client());
  await submit();
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/play/review',
      params: { setId: quizSet._id, points: '120', results: '1', from: 'room' },
    }),
  );
});
it('스터디룸에서 연 퀴즈 결과를 확인하면 이전 화면으로 돌아간다', async () => {
  setParams({ setId: quizSet._id, from: 'room' });
  await renderScreen(<QuizReviewScreen />, client());
  await fireEvent.press(await screen.findByRole('button', { name: '확인' }));
  expect(router.back).toHaveBeenCalled();
  expect(router.dismissTo).not.toHaveBeenCalled();
});
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  '완료 요청 후 화면 이탈·재진입(%s)에도 성공 결과를 복구하고 완료 요청을 반복하지 않는다',
  async (reenterBeforeResponse, withoutSetId) => {
    if (withoutSetId) setParams({});
    const pending = deferred<{ pointsEarned: number; balance: number }>();
    mockApi.quiz.finish.mockReturnValueOnce(pending.promise);
    const qc = client();
    const first = await renderScreen(<QuizSolveScreen />, qc);
    await submit();
    await first.unmount();
    if (reenterBeforeResponse) {
      await renderScreen(<QuizSolveScreen />, qc);
      const next = await screen.findByRole('button', { disabled: true });
      expect(next).toBeDisabled();
      await fireEvent.press(next);
      expect(mockApi.quiz.finish).toHaveBeenCalledTimes(1);
    }
    await act(async () => pending.resolve({ pointsEarned: 120, balance: 120 }));
    if (!reenterBeforeResponse) {
      expect(router.replace).not.toHaveBeenCalled();
      await renderScreen(<QuizSolveScreen />, client());
    }
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/play/review',
        params: { setId: quizSet._id, points: '120', results: '1' },
      }),
    );
    expect(mockApi.quiz.finish).toHaveBeenCalledTimes(1);
    expect(mockApi.quiz.startAttempt).toHaveBeenCalledTimes(1);
    expect(useQuizProgress.getState().progress).toBeNull();
  },
);
it('완료 대기 중 다른 풀이로 전환하면 이전 성공 응답이 새 진행을 바꾸지 않는다', async () => {
  const pending = deferred<{ pointsEarned: number; balance: number }>();
  mockApi.quiz.finish.mockReturnValueOnce(pending.promise);
  const first = await renderScreen(<QuizSolveScreen />, client());
  await submit();
  await first.unmount();
  const other = {
    setId: 'other',
    attemptId: 'other-attempt',
    index: 0,
    answerText: '',
    pick: null,
    right: null,
    results: [],
  };
  useQuizProgress.getState().save(other);
  await act(async () => pending.resolve({ pointsEarned: 120, balance: 120 }));
  expect(useQuizProgress.getState().progress).toEqual(other);
  expect(router.replace).not.toHaveBeenCalled();
});
it('퀴즈를 마치면 세트의 모든 문제를 보관함에 담고 보관함 캐시를 갱신한다', async () => {
  const second = { ...question, _id: 'box-q2', order: 2, prompt: '두 번째 문제' };
  mockApi.quiz.set.mockResolvedValue({
    ...quizSet,
    questionCount: 2,
    questions: [question, second],
  });
  queryClient.setQueryData(['quiz-box'], []);
  await renderScreen(<QuizSolveScreen />, client());
  await fireEvent.press(await screen.findByText('① 답'));
  await fireEvent.press(await screen.findByRole('button', { name: '다음 문제 풀기' }));
  await fireEvent.press(await screen.findByText('① 답'));
  await fireEvent.press(await screen.findByRole('button', { name: '다음 문제 풀기' }));
  await waitFor(() =>
    expect(mockApi.quiz.saveToBox).toHaveBeenCalledWith([question._id, second._id]),
  );
  expect(mockApi.quiz.saveToBox).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(queryClient.getQueryState(['quiz-box'])?.isInvalidated).toBe(true));
});
it('보관함에 담지 못하면 안내하고, 결과 화면으로는 그대로 넘어간다', async () => {
  mockApi.quiz.saveToBox.mockRejectedValueOnce(new Error('저장 실패'));
  await renderScreen(<QuizSolveScreen />, client());
  await submit();
  await waitFor(() => expect(useToast.getState().msg).toContain('보관함에 담지 못했어요'));
  expect(router.replace).toHaveBeenCalledWith({
    pathname: '/play/review',
    params: { setId: quizSet._id, points: '120', results: '1' },
  });
});
it('오늘의 복습 세트를 마치면 보관함에 담지 않고 오늘의 복습을 다시 읽는다', async () => {
  queryClient.setQueryData(['today-review'], { _id: quizSet._id, status: 'ready' });
  await renderScreen(<QuizSolveScreen />, client());
  await submit();
  await waitFor(() =>
    expect(queryClient.getQueryState(['today-review'])?.isInvalidated).toBe(true),
  );
  expect(mockApi.quiz.saveToBox).not.toHaveBeenCalled();
});
// #561: 끝낸 세트는 목록의 completed가 바뀌므로 퀴즈 탭 맨 위 카드가 돌아오자마자 바뀌게 목록을 다시 읽는다
it.each([
  ['맞춤 퀴즈', false],
  ['오늘의 복습', true],
])('%s 세트를 마치면 퀴즈 목록을 다시 읽는다(#561)', async (_, today) => {
  if (today) queryClient.setQueryData(['today-review'], { _id: quizSet._id, status: 'ready' });
  queryClient.setQueryData(['quiz-sets'], [quizSet]);
  await renderScreen(<QuizSolveScreen />, client());
  await submit();
  await waitFor(() => expect(queryClient.getQueryState(['quiz-sets'])?.isInvalidated).toBe(true));
});
it('완료 응답 전에 다른 계정으로 바뀌면 새 계정 보관함에 담지 않는다', async () => {
  const pending = deferred<{ pointsEarned: number; balance: number }>();
  mockApi.quiz.finish.mockReturnValueOnce(pending.promise);
  await renderScreen(<QuizSolveScreen />, client());
  await submit();
  useAuth.setState({ userId: 'other-owner' });
  await act(async () => pending.resolve({ pointsEarned: 120, balance: 120 }));
  expect(mockApi.quiz.saveToBox).not.toHaveBeenCalled();
});
it('결과 화면은 맞힌 문제 번호를 초록, 틀린 문제 번호를 빨강으로 칠하고 맞힌 수를 보여 준다', async () => {
  const second = { ...question, _id: 'box-q2', order: 2, prompt: '두 번째 문제' };
  mockApi.quiz.set.mockResolvedValue({
    ...quizSet,
    questionCount: 2,
    questions: [question, second],
  });
  setParams({ setId: quizSet._id, results: '10' });
  await renderScreen(<QuizReviewScreen />, client());
  expect(await screen.findByText('1 / 2 맞힘')).toBeTruthy();
  expect(String(screen.getByLabelText('1번 맞음').props.className)).toContain('bg-correct');
  expect(String(screen.getByLabelText('2번 틀림').props.className)).toContain('bg-danger');
  expect(screen.queryByText('선택')).toBeNull();
  expect(screen.queryByRole('button', { name: '보관함에 저장' })).toBeNull();
});
it('결과를 모르면(results 없음) 번호를 기본색으로 두고 맞힌 수를 보여 주지 않는다', async () => {
  await renderScreen(<QuizReviewScreen />, client());
  expect(String((await screen.findByLabelText(/^1번/)).props.className)).toContain('bg-brand');
  expect(screen.queryByText(/맞힘/)).toBeNull();
});
it('보관함 선택 모드에서 실제 선택 항목만 삭제하고 실패하면 그대로 재시도한다', async () => {
  mockApi.quiz.deleteFromBox.mockRejectedValueOnce(new Error('삭제 실패'));
  const qc = client();
  await renderScreen(<QuizBoxScreen />, qc);
  await screen.findByText(question.prompt);
  await fireEvent.press(screen.getByText('선택'));
  expect(screen.getByRole('button', { name: '선택 삭제' })).toBeDisabled();
  await fireEvent.press(screen.getByLabelText(`보관함 선택 ${question._id}`));
  await fireEvent.press(screen.getByRole('button', { name: '선택 삭제' }));
  await waitFor(() => expect(useToast.getState().msg).toContain('삭제하지 못'));
  expect(screen.getByText(question.prompt)).toBeTruthy();
  mockApi.quiz.box.mockResolvedValueOnce([]);
  await fireEvent.press(screen.getByRole('button', { name: '선택 삭제' }));
  await waitFor(() =>
    expect(mockApi.quiz.deleteFromBox).toHaveBeenNthCalledWith(2, [question._id]),
  );
  await waitFor(() => expect(screen.queryByText(question.prompt)).toBeNull());
});

it.each([
  {
    Screen: QuizReviewScreen,
    endpoint: 'set' as const,
    message: '완료한 퀴즈를 불러오지 못했어요',
  },
  { Screen: QuizBoxScreen, endpoint: 'box' as const, message: '보관함을 불러오지 못했어요' },
])(
  '$endpoint 조회 실패 후 재시도하면 보관·선택 화면을 복구한다',
  async ({ Screen, endpoint, message }) => {
    mockApi.quiz[endpoint].mockRejectedValueOnce(new Error('조회 실패'));
    await renderScreen(<Screen />, client());
    expect(await screen.findByText(message)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }));
    // 보관함은 문제만, 풀이 결과는 'Q. 문제'로 보인다
    expect(await screen.findByText(new RegExp(question.prompt))).toBeTruthy();
  },
);

it('완료 요청 이후 같은 ID의 진행을 초기화했으면 늦은 성공 응답을 무시한다', async () => {
  const pending = deferred<{ pointsEarned: number; balance: number }>();
  mockApi.quiz.finish.mockReturnValueOnce(pending.promise);
  const first = await renderScreen(<QuizSolveScreen />, client());
  await submit();
  await first.unmount();
  const previous = useQuizProgress.getState().progress!;
  useQuizProgress.getState().reset();
  useQuizProgress.getState().save(previous);
  await act(async () => pending.resolve({ pointsEarned: 120, balance: 120 }));
  expect(useQuizProgress.getState().progress?.completed).toBeUndefined();
  expect(router.replace).not.toHaveBeenCalled();
});

it('리뷰에서 보관하지 않은 문제 설명을 열어도 원래 세트의 본문을 표시한다', async () => {
  mockApi.quiz.box.mockResolvedValue([]);
  const qc = client();
  const review = await renderScreen(<QuizReviewScreen />, qc);
  await fireEvent.press(await screen.findByText(`Q. ${question.prompt}`));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/explain',
    params: { qid: question._id, setId: quizSet._id },
  });
  await review.unmount();
  setParams({ qid: question._id, setId: quizSet._id });
  await renderScreen(<QuizExplainScreen />, qc);
  expect(await screen.findByText(question.prompt)).toBeTruthy();
  expect(await screen.findByText('실제 문제 해설')).toBeTruthy();
});

it('설명 조회 실패는 안내 후 같은 문제로 재시도할 수 있다', async () => {
  mockApi.quiz.explanation.mockRejectedValueOnce(new Error('해설 실패'));
  setParams({ qid: question._id, setId: quizSet._id });
  await renderScreen(<QuizExplainScreen />, client());
  await fireEvent.press(await screen.findByRole('button', { name: '설명 다시 시도' }));
  expect(await screen.findByText('실제 문제 해설')).toBeTruthy();
  expect(screen.getByText(question.prompt)).toBeTruthy();
});

it('재진입 후 완료 요청이 실패하면 안내하고 대기 잠금을 풀어 수동 재시도를 허용한다', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  mockApi.quiz.finish.mockReturnValueOnce(pending);
  const qc = client();
  const first = await renderScreen(<QuizSolveScreen />, qc);
  await submit();
  await first.unmount();
  await renderScreen(<QuizSolveScreen />, qc);
  await screen.findByRole('button', { disabled: true });
  await act(async () => reject(new Error('완료 실패')));
  await waitFor(() => expect(useToast.getState().msg).toContain('완료 결과를 저장하지 못'));
  const retry = await screen.findByRole('button', { name: '다음 문제 풀기' });
  expect(retry).not.toBeDisabled();
  await fireEvent.press(retry);
  await waitFor(() => expect(mockApi.quiz.finish).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(router.replace).toHaveBeenCalled());
});

it('설명할 원본 문제 조회 실패를 재시도하면 문제 본문과 설명을 함께 복구한다', async () => {
  mockApi.quiz.set.mockRejectedValueOnce(new Error('원본 조회 실패'));
  setParams({ qid: question._id, setId: quizSet._id });
  await renderScreen(<QuizExplainScreen />, client());
  await fireEvent.press(await screen.findByRole('button', { name: '문제 다시 시도' }));
  expect(await screen.findByText(question.prompt)).toBeTruthy();
  expect(await screen.findByText('실제 문제 해설')).toBeTruthy();
});

it('보관함에서 사라진 문제는 빈 본문 대신 안내하고 설명 요청을 보내지 않는다', async () => {
  mockApi.quiz.box.mockResolvedValue([]);
  setParams({ qid: 'deleted-question' });
  await renderScreen(<QuizExplainScreen />, client());
  expect(await screen.findByText('문제를 찾을 수 없어요')).toBeTruthy();
  expect(mockApi.quiz.explanation).not.toHaveBeenCalled();
});

const boxQuestions = [
  { ...question, _id: 'box-a', prompt: '첫째 보관 문제', answer: '첫째 답' },
  { ...question, _id: 'box-b', prompt: '둘째 보관 문제', answer: '둘째 답' },
  { ...question, _id: 'box-c', prompt: '셋째 보관 문제', answer: '셋째 답' },
];

it('보관함은 처음에 모든 정답을 닫아 두고, 정답 보기를 누른 문제만 정답을 보여 준다', async () => {
  mockApi.quiz.box.mockResolvedValue(boxQuestions);
  await renderScreen(<QuizBoxScreen />, client());
  await screen.findByText('첫째 보관 문제');
  expect(screen.queryByText(/정답 ·/)).toBeNull();
  expect(screen.getAllByText('정답 보기')).toHaveLength(3);
  await fireEvent.press(screen.getAllByText('정답 보기')[1]!);
  expect(screen.getByText('정답 · 둘째 답')).toBeTruthy();
  expect(screen.queryByText('정답 · 첫째 답')).toBeNull();
  expect(screen.queryByText('정답 · 셋째 답')).toBeNull();
  expect(screen.getAllByText('정답 보기')).toHaveLength(2);
});

it('다른 문제를 지워 보관함을 다시 불러와도 펼쳐 둔 정답은 그대로, 나머지는 닫혀 있다', async () => {
  mockApi.quiz.box.mockResolvedValue(boxQuestions);
  await renderScreen(<QuizBoxScreen />, client());
  await screen.findByText('셋째 보관 문제');
  await fireEvent.press(screen.getAllByText('정답 보기').at(-1)!);
  expect(screen.getByText('정답 · 셋째 답')).toBeTruthy();
  mockApi.quiz.box.mockResolvedValue(boxQuestions.slice(1));
  await fireEvent.press(screen.getByText('선택'));
  await fireEvent.press(screen.getByLabelText('보관함 선택 box-a'));
  await fireEvent.press(screen.getByRole('button', { name: '선택 삭제' }));
  await waitFor(() => expect(screen.queryByText('첫째 보관 문제')).toBeNull());
  expect(mockApi.quiz.deleteFromBox).toHaveBeenCalledWith(['box-a']);
  expect(screen.getByText('정답 · 셋째 답')).toBeTruthy();
  expect(screen.queryByText('정답 · 둘째 답')).toBeNull();
});

it('펼친 문제를 지운 뒤 같은 문제가 다시 보관되면 정답은 닫힌 채로 보인다', async () => {
  mockApi.quiz.box.mockResolvedValue(boxQuestions);
  const qc = client();
  await renderScreen(<QuizBoxScreen />, qc);
  await screen.findByText('셋째 보관 문제');
  await fireEvent.press(screen.getAllByText('정답 보기').at(-1)!);
  mockApi.quiz.box.mockResolvedValue(boxQuestions.slice(0, 2));
  await fireEvent.press(screen.getByText('선택'));
  await fireEvent.press(screen.getByLabelText('보관함 선택 box-c'));
  await fireEvent.press(screen.getByRole('button', { name: '선택 삭제' }));
  await waitFor(() => expect(screen.queryByText('셋째 보관 문제')).toBeNull());
  // 화면이 떠 있는 동안 풀이 화면이 같은 문제를 다시 보관하고 보관함을 무효화한 경우
  mockApi.quiz.box.mockResolvedValue(boxQuestions);
  await act(async () => qc.invalidateQueries({ queryKey: ['quiz-box'] }));
  expect(await screen.findByText('셋째 보관 문제')).toBeTruthy();
  expect(screen.queryByText(/정답 ·/)).toBeNull();
});
