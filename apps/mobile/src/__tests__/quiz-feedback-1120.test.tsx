import { fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { Question, QuizSet } from '@notelink/shared';
import { QuizBoxScreen, QuizHomeScreen, QuizSimilarScreen } from '../features/quiz/quiz';
import { WrongReviewScreen } from '../features/quiz/wrong-review';
import { api } from '../lib/api';
import { ApiError } from '../lib/api/http';
import { queryClient } from '../lib/query';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

// 실기기 피드백(2026-11-20): 유사 퀴즈 · 오늘의 오답 복습 보기 · 퀴즈 보관함 문제 목록
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
const mockFiles = new Map<string, string>();
jest.mock('../lib/local/storage', () => ({
  ...jest.requireActual('../lib/local/storage'),
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => mockFiles.set(n, JSON.stringify(d)),
  dropDb: (n: string) => mockFiles.delete(n),
}));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const quizSet = (_id: string, title: string, over: Partial<QuizSet> = {}) =>
  ({
    _id,
    title,
    status: 'ready',
    questionCount: 2,
    // 유사 퀴즈 바로가기는 노트 · 폴더 · 문제가 있는 끝낸 세트가 있어야 보인다(#605, canPickFrom)
    materialId: 'm1',
    folderId: 'f1',
    questions: [
      {
        _id: `${_id}-q1`,
        order: 1,
        type: 'short_answer',
        prompt: '문제',
        choices: null,
        answer: '답',
        explanation: null,
        conceptTags: [],
      },
    ],
    ...over,
  }) as QuizSet;
const LONG =
  'await new Promise((resolve) => setTimeout(resolve, 2000))처럼 Promise로 감싸 기다린다';
const mc = (id: string, over: Partial<Question> = {}): Question => ({
  _id: id,
  order: 0,
  type: 'multiple_choice',
  // 서버(toAppQuestion)는 지문을 질문 아래 빈 줄 뒤에 붙인다
  prompt: '다음 중 setTimeout에 대한 설명으로 옳지 않은 것은?\n\nsetTimeout Promise 인위적 지연',
  choices: [LONG, '스트리밍 동작을 확인하려고 넣는다'],
  answer: LONG,
  explanation: null,
  conceptTags: [],
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.clear();
  setParams({});
  useToast.setState({ msg: null } as never);
  jest.spyOn(api.quiz, 'today').mockResolvedValue(null);
});
afterEach(() => {
  jest.restoreAllMocks();
  useQuizProgress.getState().reset();
  queryClient.clear();
});

describe('유사 퀴즈', () => {
  it('바로가기는 끝까지 푼 세트가 있으면 보이고, 세트를 넘기지 않고 노트 고르기부터 연다(#605)', async () => {
    jest
      .spyOn(api.quiz, 'sets')
      .mockResolvedValue([
        quizSet('copy', 'JS 기초 · 다시 보기'),
        quizSet('doing', '풀던 퀴즈'),
        quizSet('done', 'JS 기초', { completed: true }),
      ]);
    useQuizProgress.getState().save({
      setId: 'doing',
      attemptId: 'a1',
      index: 1,
      answerText: '',
      pick: null,
      right: null,
      results: [true],
    });
    await renderScreen(<QuizHomeScreen />, client());
    await screen.findByText('풀던 퀴즈 · 2문제');
    await fireEvent.press(screen.getByText('유사 퀴즈'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/play/similar', params: {} });
  });

  it('끝낸 세트가 하나도 없으면 유사 퀴즈 바로가기를 보이지 않는다(빈 id로 서버를 부르지 않게)', async () => {
    jest
      .spyOn(api.quiz, 'sets')
      .mockResolvedValue([quizSet('copy', 'JS 기초 · 다시 보기'), quizSet('doing', '풀던 퀴즈')]);
    await renderScreen(<QuizHomeScreen />, client());
    await screen.findByText('퀴즈 보관함');
    expect(screen.queryByText('유사 퀴즈')).toBeNull();
    expect(screen.getByText('플래시 카드')).toBeTruthy();
  });

  it('서버가 거절(4xx)하면 그 문구만 보여 주고 연결 오류 토스트는 띄우지 않는다', async () => {
    jest
      .spyOn(api.quiz, 'similar')
      .mockRejectedValue(
        new ApiError('VALIDATION_FAILED', '먼저 이 퀴즈를 끝까지 풀어 주세요', 409),
      );
    setParams({ setId: 'qs1' });
    await renderScreen(<QuizSimilarScreen />, queryClient);
    await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
    expect(await screen.findByText('먼저 이 퀴즈를 끝까지 풀어 주세요')).toBeTruthy();
    expect(useToast.getState().msg).toBeNull();
  });
});

it('공용 토스트: 서버가 4xx로 거절하면 연결 문구 대신 서버 문구, 연결 · 5xx 오류는 연결 문구', async () => {
  const run = (e: Error) =>
    queryClient
      .getMutationCache()
      .build(queryClient, { mutationFn: () => Promise.reject(e) })
      .execute(undefined)
      .catch(() => {});
  await run(new ApiError('VALIDATION_FAILED', '틀린 문제가 없어요', 409));
  expect(useToast.getState().msg).toBe('틀린 문제가 없어요');
  await run(new ApiError('INTERNAL', '서버 오류', 500));
  expect(useToast.getState().msg).toContain('연결을 확인하고');
});

describe('오늘의 오답 복습 보기', () => {
  it('보기는 번호와 함께 여러 줄로 다 보이고, 지문(개념 이름)은 질문과 나눠 작게 보인다', async () => {
    useAuth.setState({ userId: 'u1' });
    mockFiles.set(
      'wrong-u1',
      JSON.stringify({ items: [{ ...mc('w1'), setTitle: '오늘의 복습 · 11-19' }], shownOn: null }),
    );
    await renderScreen(<WrongReviewScreen />, client());
    expect(screen.getByText('Q. 다음 중 setTimeout에 대한 설명으로 옳지 않은 것은?')).toBeTruthy();
    expect(String(screen.getByText('setTimeout Promise 인위적 지연').props.className)).toContain(
      'text-sub',
    );
    const choice = screen.getByText(`① ${LONG}`);
    expect(choice.props.numberOfLines).toBeUndefined();
    expect(screen.getByText('② 스트리밍 동작을 확인하려고 넣는다')).toBeTruthy();
  });
});

describe('퀴즈 보관함', () => {
  it('ㄱ·ㄴ·ㄷ처럼 여러 줄 지문은 풀이에 필요하므로 흐리게 줄이지 않는다', async () => {
    const passage = 'ㄱ. 첫째 설명\nㄴ. 둘째 설명';
    jest
      .spyOn(api.quiz, 'box')
      .mockResolvedValue([mc('b2', { prompt: `옳은 것은?\n\n${passage}` })]);
    setParams({ folderId: 'fo1' }); // 노트를 고른 2단계(#601)
    await renderScreen(<QuizBoxScreen />, client());
    expect(String((await screen.findByText(passage)).props.className)).toContain('text-ink');
  });

  it('객관식 문제는 보기를 번호와 함께 보여 준다', async () => {
    jest.spyOn(api.quiz, 'box').mockResolvedValue([mc('b1')]);
    setParams({ folderId: 'fo1' }); // 노트를 고른 2단계(#601)
    await renderScreen(<QuizBoxScreen />, client());
    expect(await screen.findByText(`① ${LONG}`)).toBeTruthy();
    expect(screen.getByText('② 스트리밍 동작을 확인하려고 넣는다')).toBeTruthy();
    expect(String(screen.getByText('setTimeout Promise 인위적 지연').props.className)).toContain(
      'text-sub',
    );
  });
});
