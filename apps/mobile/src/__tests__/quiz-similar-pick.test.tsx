import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { PATHS, type Folder, type Question, type QuizSet } from '@notelink/shared';
import { QuizHomeScreen, QuizSimilarScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { http } from '../lib/api/http';
import { httpApi } from '../lib/api/http-api';
import { queryClient } from '../lib/query';
import { useQuizProgress } from '../stores/quiz-progress';
import { DEMO_FOLDER } from './fixtures/seed';
import { renderScreen, setParams } from '../test-utils';

// 유사 퀴즈: 1단계 노트(학습 폴더) → 2단계 그 노트에서 끝낸 퀴즈의 문제 목록(틀린 문제 기본 체크) → 고른 문제로 만들기
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const FOLDERS: (Folder & { materialCount: number })[] = [
  { ...DEMO_FOLDER, _id: 'fA', title: '수학 폴더', materialCount: 1 },
  { ...DEMO_FOLDER, _id: 'fB', title: '영어 폴더', materialCount: 1 },
];
const question = (id: string, order = 1): Question => ({
  _id: id,
  order,
  type: 'short_answer',
  prompt: `문제 ${id}`,
  choices: null,
  answer: `답 ${id}`,
  explanation: null,
  conceptTags: [],
});
const quizSet = (
  id: string,
  folderId: string,
  questions: Question[],
  extra: Partial<QuizSet> = {},
): QuizSet => ({
  _id: id,
  materialId: `m-${folderId}`,
  folderId,
  sourceSetId: null,
  title: `세트 ${id}`,
  status: 'ready',
  progress: 100,
  questionCount: questions.length,
  questions,
  createdAt: '2026-11-20T00:00:00.000Z',
  completed: true,
  reviewDay: null,
  wrongQuestionIds: [],
  ...extra,
});

const SETS: QuizSet[] = [
  quizSet('s1', 'fA', [question('a1', 1), question('a2', 2), question('a3', 3)], {
    wrongQuestionIds: ['a2'],
  }),
  quizSet('s2', 'fA', [question('b1', 1)], { wrongQuestionIds: ['b1'] }),
  // 끝내지 않은 세트 · 다른 노트 · 오늘의 복습 · 만드는 중인 세트는 2단계에 보이지 않는다
  quizSet('s3', 'fA', [question('c1')], { completed: false }),
  quizSet('s4', 'fB', [question('d1')], { wrongQuestionIds: ['d1'] }),
  quizSet('s5', 'fA', [question('e1')], { reviewDay: '2026-11-20', wrongQuestionIds: ['e1'] }),
  quizSet('s6', 'fB', [], { status: 'generating', completed: false }),
];

const checkbox = (id: string) => screen.getByLabelText(`유사 퀴즈 고르기 문제 ${id}`);
const checked = (id: string) => checkbox(id).props.accessibilityState?.checked;
const makeBtn = () => screen.getByRole('button', { name: /유사 퀴즈 만들기/ });

beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
  jest.spyOn(api.content, 'folders').mockResolvedValue(FOLDERS);
  jest.spyOn(api.quiz, 'today').mockResolvedValue(null);
  jest.spyOn(api.quiz, 'sets').mockResolvedValue(SETS);
});
afterEach(() => {
  jest.restoreAllMocks();
  setParams({});
  useQuizProgress.getState().reset();
  queryClient.clear();
});

describe('들어가는 길', () => {
  it('퀴즈 홈 바로가기는 세트를 넘기지 않고 노트 고르기(1단계)부터 연다', async () => {
    await renderScreen(<QuizHomeScreen />, client());
    await fireEvent.press(await screen.findByText('유사 퀴즈'));
    const to = (router.push as jest.Mock).mock.calls.find(
      ([x]) => x.pathname === '/play/similar',
    )?.[0];
    expect(to).toBeTruthy();
    expect(to.params?.setId).toBeUndefined();
    expect(to.params?.folderId).toBeUndefined();
  });

  it('퀴즈 결과 화면에서 세트를 넘기면(setId) 지금처럼 그 세트의 다시 보기를 만든다', async () => {
    const similar = jest
      .spyOn(api.quiz, 'similar')
      .mockResolvedValue({ ...SETS[0]!, _id: 'r1', status: 'generating', questions: [] });
    const pick = jest.spyOn(api.quiz, 'similarPick');
    setParams({ setId: 's1' });
    await renderScreen(<QuizSimilarScreen />, client());
    expect(screen.queryByText('수학 폴더')).toBeNull();
    await fireEvent.press(makeBtn());
    expect(similar).toHaveBeenCalledWith('s1');
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('1단계 노트 고르기', () => {
  it('학습 폴더 카드를 보이고, 고르면 그 폴더로 다시 연다. 전체 보기는 없다', async () => {
    await renderScreen(<QuizSimilarScreen />, client());
    expect(await screen.findByText('수학 폴더')).toBeTruthy();
    expect(screen.getByText('영어 폴더')).toBeTruthy();
    expect(screen.queryByText('전체 보기')).toBeNull();
    await fireEvent.press(screen.getByText('수학 폴더'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/play/similar',
      params: { folderId: 'fA' },
    });
  });
});

describe('2단계 문제 고르기', () => {
  it('그 노트에서 끝낸 퀴즈의 문제만 보이고, 마지막 풀이에서 틀린 문제는 처음부터 체크돼 있다', async () => {
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizSimilarScreen />, client());
    expect(await screen.findByText('문제 a1')).toBeTruthy();
    for (const id of ['a2', 'a3', 'b1']) expect(screen.getByText(`문제 ${id}`)).toBeTruthy();
    for (const id of ['c1', 'd1', 'e1']) expect(screen.queryByText(`문제 ${id}`)).toBeNull();
    // 세트별로 묶어 보인다
    expect(screen.getByText('세트 s1')).toBeTruthy();
    expect(screen.getByText('세트 s2')).toBeTruthy();
    expect(checked('a1')).toBe(false);
    expect(checked('a2')).toBe(true);
    expect(checked('a3')).toBe(false);
    expect(checked('b1')).toBe(true);
  });

  it('체크를 바꾸면 고른 문제만 서버로 보내고, 만들면 풀이 화면으로 간다', async () => {
    const pick = jest
      .spyOn(api.quiz, 'similarPick')
      .mockResolvedValue({ ...SETS[0]!, _id: 'new', title: '수학 · 유사 퀴즈' });
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizSimilarScreen />, client());
    await screen.findByText('문제 a1');
    await fireEvent.press(checkbox('a2')); // 틀린 문제 빼기
    await fireEvent.press(checkbox('a3')); // 맞힌 문제 넣기
    expect(checked('a2')).toBe(false);
    expect(checked('a3')).toBe(true);
    await fireEvent.press(makeBtn());
    expect(pick).toHaveBeenCalledWith(['a3', 'b1']);
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/play/solve',
        params: { setId: 'new' },
      }),
    );
  });

  it('하나도 고르지 않으면 만들기 버튼을 누를 수 없다', async () => {
    const pick = jest.spyOn(api.quiz, 'similarPick');
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizSimilarScreen />, client());
    await screen.findByText('문제 a1');
    await fireEvent.press(checkbox('a2'));
    await fireEvent.press(checkbox('b1'));
    expect(makeBtn().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(makeBtn());
    expect(pick).not.toHaveBeenCalled();
  });

  it('한 번에 10문제까지 고른다: 틀린 문제가 더 많으면 10개만 체크하고 더 고르지 못한다', async () => {
    const many = Array.from({ length: 12 }, (_, i) => question(`w${i}`, i + 1));
    jest
      .spyOn(api.quiz, 'sets')
      .mockResolvedValue([
        quizSet('big', 'fA', many, { wrongQuestionIds: many.map((q) => q._id) }),
      ]);
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizSimilarScreen />, client());
    await screen.findByText('문제 w0');
    expect(many.filter((q) => checked(q._id)).length).toBe(10);
    await fireEvent.press(checkbox('w11'));
    expect(checked('w11')).toBe(false);
    expect(screen.getByText(/최대 10문제/)).toBeTruthy();
  });

  it('그 노트에 끝낸 퀴즈가 없으면 안내를 보이고 만들기 버튼은 누를 수 없다', async () => {
    setParams({ folderId: 'fB' });
    jest.spyOn(api.quiz, 'sets').mockResolvedValue([SETS[2]!]);
    await renderScreen(<QuizSimilarScreen />, client());
    expect(await screen.findByText('이 노트에서 끝까지 푼 퀴즈가 없어요')).toBeTruthy();
    expect(makeBtn().props.accessibilityState?.disabled).toBe(true);
  });
});

describe('실서버 호출', () => {
  it('고른 문제로 만들기는 새 경로에 문제 id 목록을 보낸다', async () => {
    const post = jest.spyOn(http, 'post').mockResolvedValue({});
    await httpApi.quiz.similarPick(['a3', 'b1']);
    expect(post).toHaveBeenCalledWith(PATHS.similarQuizPick, { questionIds: ['a3', 'b1'] });
  });
});

describe('서버가 받는 세트만(code-review)', () => {
  it('노트가 없는 세트는 2단계에 보이지 않는다(서버가 404로 거절)', async () => {
    jest
      .spyOn(api.quiz, 'sets')
      .mockResolvedValue([
        quizSet('s1', 'fA', [question('a1')], { wrongQuestionIds: ['a1'] }),
        quizSet('s9', 'fA', [question('z1')], { materialId: '', wrongQuestionIds: ['z1'] }),
      ]);
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizSimilarScreen />, client());
    expect(await screen.findByText('문제 a1')).toBeTruthy();
    expect(screen.queryByText('문제 z1')).toBeNull();
  });

  it('끝낸 세트가 오늘의 복습뿐이면 퀴즈 홈에 유사 퀴즈 바로가기를 보이지 않는다', async () => {
    jest
      .spyOn(api.quiz, 'sets')
      .mockResolvedValue([quizSet('t1', 'fA', [question('t1q')], { reviewDay: '2026-11-20' })]);
    await renderScreen(<QuizHomeScreen />, client());
    expect(await screen.findByText('퀴즈 보관함')).toBeTruthy();
    expect(screen.queryByText('유사 퀴즈')).toBeNull();
  });
});

describe('같은 노트로 만드는 중일 때(code-review 2차)', () => {
  it('퀴즈를 끝낸 직후처럼 이 노트로 만드는 중인 세트가 있으면 만들기를 막고, 끝나면 풀어 준다', async () => {
    const pick = jest.spyOn(api.quiz, 'similarPick').mockResolvedValue({ ...SETS[0]!, _id: 'new' });
    const making = quizSet('r1', 'fA', [], { status: 'generating', completed: false });
    const sets = jest.spyOn(api.quiz, 'sets').mockResolvedValue([...SETS, making]);
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizSimilarScreen />, client());
    await screen.findByText('문제 a1');
    const btn = () =>
      screen.getByRole('button', { name: /끝나면 만들 수 있어요|유사 퀴즈 만들기/ });
    expect(btn().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(btn());
    expect(pick).not.toHaveBeenCalled();
    // 만드는 중인 세트가 끝나면(다시 읽은 목록) 만들 수 있다
    sets.mockResolvedValue(SETS);
    await waitFor(() => expect(makeBtn().props.accessibilityState?.disabled).toBe(false), {
      timeout: 6000,
    });
    await fireEvent.press(makeBtn());
    expect(pick).toHaveBeenCalledWith(['a2', 'b1']);
  });
});

describe('code-review 3차', () => {
  it('폴더 정보가 없는 옛 세트만 끝냈으면 퀴즈 홈에 유사 퀴즈 바로가기를 보이지 않는다', async () => {
    jest
      .spyOn(api.quiz, 'sets')
      .mockResolvedValue([quizSet('o1', '', [question('o1q')], { wrongQuestionIds: ['o1q'] })]);
    await renderScreen(<QuizHomeScreen />, client());
    expect(await screen.findByText('퀴즈 보관함')).toBeTruthy();
    expect(screen.queryByText('유사 퀴즈')).toBeNull();
  });

  it('같은 폴더의 다른 노트로 만드는 중이면 막지 않는다(서버도 노트마다 하나)', async () => {
    const pick = jest.spyOn(api.quiz, 'similarPick').mockResolvedValue({ ...SETS[0]!, _id: 'new' });
    const other = quizSet('r2', 'fA', [], {
      status: 'generating',
      completed: false,
      materialId: 'm-other',
    });
    jest.spyOn(api.quiz, 'sets').mockResolvedValue([...SETS, other]);
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizSimilarScreen />, client());
    await screen.findByText('문제 a1');
    expect(makeBtn().props.accessibilityState?.disabled).toBe(false);
    await fireEvent.press(makeBtn());
    expect(pick).toHaveBeenCalledWith(['a2', 'b1']);
  });
});
