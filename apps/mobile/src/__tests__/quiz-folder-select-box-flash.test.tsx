import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { PATHS, type Flashcard, type Folder, type Question, type QuizSet } from '@notelink/shared';
import {
  CardsScreen,
  FlashScreen,
  QuizBoxScreen,
  QuizExplainScreen,
  QuizHomeScreen,
  QuizNotesScreen,
} from '../features/quiz/quiz';
import { api } from '../lib/api';
import { http } from '../lib/api/http';
import { httpApi } from '../lib/api/http-api';
import { queryClient } from '../lib/query';
import { useQuizProgress } from '../stores/quiz-progress';
import { DEMO_FOLDER, makeMaterial } from './fixtures/seed';
import { renderScreen, setParams } from '../test-utils';

// #601 퀴즈 보관함 · 플래시카드도 퀴즈 만들기(#575)처럼 1단계 노트(학습 폴더) → 2단계 그 노트의 항목으로 고른다
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
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
const FOLDERS: (Folder & { materialCount: number })[] = [
  { ...DEMO_FOLDER, _id: 'fA', title: '수학 폴더', materialCount: 1 },
  { ...DEMO_FOLDER, _id: 'fB', title: '영어 폴더', materialCount: 1 },
];
const card = (id: string, folderId: string | null): Flashcard => ({
  _id: id,
  materialId: null,
  folderId,
  front: `앞 ${id}`,
  back: `뒤 ${id}`,
  sourceQuizSetId: null,
  sourceQuestionId: null,
  lastResult: null,
  createdAt: '2026-11-20T00:00:00.000Z',
});
// 수학 카드 2장, 영어 카드 1장, 폴더 정보가 없는 예전 카드 1장
const CARDS = [card('m1', 'fA'), card('e1', 'fB'), card('old', null), card('m2', 'fA')];
const question = (id: string): Question => ({
  _id: id,
  order: 0,
  type: 'short_answer',
  prompt: `보관 문제 ${id}`,
  choices: null,
  answer: `답 ${id}`,
  explanation: null,
  conceptTags: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.clear();
  setParams({});
  jest.spyOn(api.content, 'folders').mockResolvedValue(FOLDERS);
  jest.spyOn(api.quiz, 'today').mockResolvedValue(null);
});
afterEach(() => {
  jest.restoreAllMocks();
  setParams({});
  useQuizProgress.getState().reset();
  queryClient.clear();
});

describe('퀴즈 보관함', () => {
  it('노트를 고르기 전(1단계)에는 학습 폴더 카드를 보이고, 보관함 전체를 읽지 않는다', async () => {
    const box = jest.spyOn(api.quiz, 'box').mockResolvedValue([question('q1')]);
    await renderScreen(<QuizBoxScreen />, client());
    expect(await screen.findByText('수학 폴더')).toBeTruthy();
    expect(screen.getByText('영어 폴더')).toBeTruthy();
    expect(screen.queryByText('보관 문제 q1')).toBeNull();
    expect(box).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('영어 폴더'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/play/box',
      params: { folderId: 'fB' },
    });
  });

  it('고른 노트(2단계)에서는 그 폴더의 보관 문제만 서버에 묻는다', async () => {
    const box = jest.spyOn(api.quiz, 'box').mockResolvedValue([question('q1')]);
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizBoxScreen />, client());
    expect(await screen.findByText('보관 문제 q1')).toBeTruthy();
    expect(box).toHaveBeenCalledWith('fA');
    expect(screen.queryByText('영어 폴더')).toBeNull();
  });

  it('실서버 보관함은 폴더를 주면 folderId 쿼리로, 안 주면 지금처럼 전체를 부른다', async () => {
    const get = jest.spyOn(http, 'get').mockResolvedValue([]);
    await httpApi.quiz.box('fA');
    await httpApi.quiz.box();
    expect(get).toHaveBeenNthCalledWith(1, PATHS.quizBox, { folderId: 'fA' });
    expect(get).toHaveBeenNthCalledWith(2, PATHS.quizBox, undefined);
  });
});

describe('폴더 고르기(1단계)', () => {
  it('폴더를 읽는 동안 불러오는 중을, 검색에 맞는 노트가 없으면 안내를 보인다', async () => {
    let done!: (v: typeof FOLDERS) => void;
    jest.spyOn(api.content, 'folders').mockReturnValue(new Promise((r) => (done = r)));
    await renderScreen(<QuizBoxScreen />, client());
    expect(screen.getByLabelText('노트를 불러오는 중')).toBeTruthy();
    await act(async () => done(FOLDERS));
    expect(await screen.findByText('수학 폴더')).toBeTruthy();
    expect(screen.queryByLabelText('노트를 불러오는 중')).toBeNull();
    await fireEvent.changeText(screen.getByPlaceholderText('노트 검색'), '과학');
    expect(screen.getByText('찾는 노트가 없어요')).toBeTruthy();
    expect(screen.queryByText('수학 폴더')).toBeNull();
  });
});

describe('플래시 카드', () => {
  it('노트를 고르기 전(1단계)에는 학습 폴더 카드를 보이고, 고르면 그 폴더로 다시 연다', async () => {
    jest.spyOn(api.quiz, 'flashcards').mockResolvedValue(CARDS);
    await renderScreen(<FlashScreen />, client());
    expect(await screen.findByText('수학 폴더')).toBeTruthy();
    expect(screen.queryByText('앞 m1')).toBeNull();
    await fireEvent.press(screen.getByText('수학 폴더'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/play/flash',
      params: { folderId: 'fA' },
    });
  });

  it('고른 노트의 카드만 넘겨 보고, 폴더 정보가 없는 카드는 보이지 않는다', async () => {
    jest.spyOn(api.quiz, 'flashcards').mockResolvedValue(CARDS);
    setParams({ folderId: 'fA' });
    await renderScreen(<FlashScreen />, client());
    expect(await screen.findByText('앞 m1')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('다음 카드'));
    expect(await screen.findByText('앞 m2')).toBeTruthy();
    expect(screen.getByText('2 / 2')).toBeTruthy();
    expect(screen.queryByText('앞 e1')).toBeNull();
    expect(screen.queryByText('앞 old')).toBeNull();
    // 모아보기도 같은 노트로 연다
    await fireEvent.press(screen.getByText('모아보기'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/play/cards',
      params: { folderId: 'fA' },
    });
  });

  it('그 노트에 카드가 없으면 지금 동작(퀴즈를 만들면 카드가 생김)에 맞는 안내를 보인다', async () => {
    jest.spyOn(api.quiz, 'flashcards').mockResolvedValue([card('old', null)]);
    setParams({ folderId: 'fA' });
    await renderScreen(<FlashScreen />, client());
    expect(await screen.findByText('저장한 플래시 카드가 없어요')).toBeTruthy();
    expect(screen.getByText('이 노트로 퀴즈를 만들면 플래시 카드가 생겨요.')).toBeTruthy();
    expect(screen.queryByText(/플래시카드 저장/)).toBeNull();
    expect(screen.queryByText('앞 old')).toBeNull();
  });

  it('모아보기도 그 노트의 카드만 보이고, 누르면 같은 노트의 그 카드 위치로 돌아간다', async () => {
    jest.spyOn(api.quiz, 'flashcards').mockResolvedValue(CARDS);
    setParams({ folderId: 'fA' });
    await renderScreen(<CardsScreen />, client());
    expect(await screen.findByText('앞 m2')).toBeTruthy();
    expect(screen.getByText('2장')).toBeTruthy();
    expect(screen.queryByText('앞 e1')).toBeNull();
    expect(screen.queryByText('앞 old')).toBeNull();
    await fireEvent.press(screen.getByText('앞 m2'));
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/play/flash',
      params: { i: '1', folderId: 'fA' },
    });
  });

  it('모아보기에 카드가 없으면 지금 동작에 맞는 안내를 보인다', async () => {
    jest.spyOn(api.quiz, 'flashcards').mockResolvedValue([card('e1', 'fB')]);
    setParams({ folderId: 'fA' });
    await renderScreen(<CardsScreen />, client());
    expect(await screen.findByText('이 노트로 퀴즈를 만들면 플래시 카드가 생겨요.')).toBeTruthy();
    expect(screen.queryByText('앞 e1')).toBeNull();
  });
});

describe('2단계 보조 동작(code-review 2차)', () => {
  it('노트 보관함에서 연 AI 설명은 그 폴더 보관함 캐시를 그대로 써서 보관함을 다시 읽지 않는다', async () => {
    const box = jest.spyOn(api.quiz, 'box').mockResolvedValue([question('q1')]);
    jest.spyOn(api.quiz, 'explanation').mockResolvedValue({ text: '설명' });
    // 앱의 queryClient(lib/query.ts)처럼 30초 동안은 새로 읽지 않는다
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    setParams({ folderId: 'fA' });
    const view = await renderScreen(<QuizBoxScreen />, qc);
    await fireEvent.press(await screen.findByText('AI 설명 보기'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/play/explain',
      params: { qid: 'q1', folderId: 'fA' },
    });
    await view.unmount();
    setParams({ qid: 'q1', folderId: 'fA' });
    await renderScreen(<QuizExplainScreen />, qc);
    expect(await screen.findByText(/보관 문제 q1/)).toBeTruthy();
    expect(box).toHaveBeenCalledTimes(1);
  });

  it('카드를 읽는 동안 불러오는 중을 보이고, 카드가 없으면 앞 화면으로 돌아가게 한다', async () => {
    let done!: (v: Flashcard[]) => void;
    jest.spyOn(api.quiz, 'flashcards').mockReturnValue(new Promise((r) => (done = r)));
    setParams({ folderId: 'fA' });
    await renderScreen(<FlashScreen />, client());
    expect(screen.getByLabelText('카드를 불러오는 중')).toBeTruthy();
    await act(async () => done([card('e1', 'fB')]));
    expect(await screen.findByText('저장한 플래시 카드가 없어요')).toBeTruthy();
    expect(screen.queryByLabelText('카드를 불러오는 중')).toBeNull();
    await fireEvent.press(screen.getByText('돌아가기'));
    expect(router.back).toHaveBeenCalled();
  });

  it('모아보기도 카드를 읽는 동안 불러오는 중을 보인다', async () => {
    jest.spyOn(api.quiz, 'flashcards').mockReturnValue(new Promise(() => {}));
    setParams({ folderId: 'fA' });
    await renderScreen(<CardsScreen />, client());
    expect(screen.getByLabelText('카드를 불러오는 중')).toBeTruthy();
  });
});

describe('들어가는 길', () => {
  beforeEach(() => {
    jest
      .spyOn(api.content, 'materials')
      .mockResolvedValue([
        makeMaterial('fA', 'handwriting', { _id: 'mA1', title: '근의 공식 정리' }),
      ]);
  });

  it('퀴즈 만들기 2단계의 + 메뉴는 이미 고른 노트로 플래시 카드 · 보관함을 연다', async () => {
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizNotesScreen />, client());
    await screen.findByText('근의 공식 정리');
    await fireEvent.press(screen.getByLabelText('메뉴'));
    await fireEvent.press(await screen.findByText('플래시 카드'));
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/play/flash',
      params: { folderId: 'fA' },
    });
    await fireEvent.press(screen.getByLabelText('메뉴'));
    await fireEvent.press(await screen.findByText('퀴즈 보관함'));
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/play/box',
      params: { folderId: 'fA' },
    });
  });

  it('퀴즈 만들기 1단계의 + 메뉴는 노트를 모르므로 폴더 고르기(1단계)로 연다', async () => {
    await renderScreen(<QuizNotesScreen />, client());
    await screen.findByText('수학 폴더');
    await fireEvent.press(screen.getByLabelText('메뉴'));
    await fireEvent.press(await screen.findByText('플래시 카드'));
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/play/flash', params: {} });
  });

  it('퀴즈 만들기 1단계 폴더 카드는 그대로 그 폴더의 자료 고르기(2단계)를 연다', async () => {
    await renderScreen(<QuizNotesScreen />, client());
    await fireEvent.press(await screen.findByText('수학 폴더'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/quiz/notes',
      params: { folderId: 'fA' },
    });
    expect(screen.getByText('어떤 노트로 퀴즈를 만들까요?')).toBeTruthy();
    // 노트 탭과 같은 카드: 과목 · 만든 날 · 자료 수
    expect(screen.getAllByText(/수학 · .* · 자료 1개/)).toHaveLength(2);
  });

  it('퀴즈 홈 바로가기는 노트를 넘기지 않아 플래시 카드 · 보관함이 폴더 고르기부터 시작한다', async () => {
    jest.spyOn(api.quiz, 'sets').mockResolvedValue([
      {
        _id: 's1',
        title: '세트',
        status: 'ready',
        questionCount: 2,
        questions: [],
      } as never as QuizSet,
    ]);
    await renderScreen(<QuizHomeScreen />, client());
    await fireEvent.press(await screen.findByText('플래시 카드'));
    await fireEvent.press(screen.getByText('퀴즈 보관함'));
    const calls = (router.push as jest.Mock).mock.calls.map(([to]) => to);
    for (const pathname of ['/play/flash', '/play/box'])
      expect(calls.find((to) => to.pathname === pathname)?.params?.folderId).toBeUndefined();
    await waitFor(() => expect(calls).toHaveLength(2));
  });
});
