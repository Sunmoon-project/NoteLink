import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { QuizNotesScreen, QuizSimilarScreen } from '../features/quiz/quiz';
import { api, ApiError } from '../lib/api';
import type { Material } from '@notelink/shared';
import { mockDemo } from './fixtures/api';
import { DEMO_FOLDER, makeMaterial } from './fixtures/seed';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
// 어느 시험이 2단계(folderId)를 열어도 다음 시험으로 새지 않게 한다(code-review 3차)
afterEach(() => setParams({}));

// PR #39 리뷰
describe('퀴즈 만들 노트 고르기', () => {
  it('폴더가 아니라 노트(자료) ID로 퀴즈를 만든다', async () => {
    mockDemo.seedFolder();
    const folders = await api.content.folders();
    const ms = (await Promise.all(folders.map((f) => api.content.materials(f._id)))).flat();
    const note = ms.find((m) => !m.processing || m.processing.status === 'done')!;
    // 2단계(폴더를 고른 화면)에서 자료를 고른다(#575)
    setParams({ folderId: note.folderId });
    await renderScreen(<QuizNotesScreen />);
    await fireEvent.press(await screen.findByText(note.title));
    expect(router.push).not.toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/play/gen' }),
    );
    await fireEvent.press(screen.getByLabelText('메뉴'));
    await fireEvent.press(screen.getByText('퀴즈 만들기'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/play/gen',
      params: { materialId: note._id, title: note.title },
    });
    expect(folders.some((f) => f._id === note._id)).toBe(false);
  });
});

// #575: 퀴즈 만들기는 노트 탭처럼 학습 폴더 → 그 폴더의 정리 끝난 자료 2단계로 고른다
describe('퀴즈 만들기 2단계(학습 폴더 → 자료)', () => {
  const folder = (_id: string, title: string, materialCount: number) => ({
    ...DEMO_FOLDER,
    _id,
    title,
    materialCount,
  });
  const FOLDERS = [
    folder('fA', '수학 폴더', 2),
    folder('fB', '영어 폴더', 1),
    folder('fC', '빈 폴더', 1),
  ];
  const MATERIALS: Record<string, Material[]> = {
    fA: [
      makeMaterial('fA', 'handwriting', { _id: 'mA1', title: '근의 공식 정리' }),
      makeMaterial('fA', 'recording', {
        _id: 'mA2',
        title: '정리 중인 녹음',
        processing: { status: 'processing', progress: 40, jobId: 'j1' },
      }),
    ],
    fB: [makeMaterial('fB', 'document', { _id: 'mB1', title: '영어 단어장' })],
    fC: [
      makeMaterial('fC', 'document', {
        _id: 'mC1',
        title: '아직 정리 중인 문서',
        processing: { status: 'queued', progress: 0, jobId: 'j2' },
      }),
    ],
  };
  let materials: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    setParams({});
    jest.spyOn(api.content, 'folders').mockResolvedValue(FOLDERS as never);
    materials = jest
      .spyOn(api.content, 'materials')
      .mockImplementation(async (id: string) => MATERIALS[id] ?? []);
  });
  afterEach(() => jest.restoreAllMocks());

  it('1단계는 학습 폴더 카드만 보이고 자료는 보이지 않으며, 자료 목록을 부르지 않는다', async () => {
    await renderScreen(<QuizNotesScreen />);
    expect(await screen.findByText('수학 폴더')).toBeTruthy();
    expect(screen.getByText('영어 폴더')).toBeTruthy();
    expect(screen.getByText('어떤 노트로 퀴즈를 만들까요?')).toBeTruthy();
    expect(screen.getByPlaceholderText('노트 검색')).toBeTruthy();
    expect(screen.queryByText('근의 공식 정리')).toBeNull();
    expect(screen.queryByText('영어 단어장')).toBeNull();
    expect(materials).not.toHaveBeenCalled();
  });

  it('1단계 검색은 폴더 이름으로 거른다', async () => {
    await renderScreen(<QuizNotesScreen />);
    await screen.findByText('수학 폴더');
    fireEvent.changeText(screen.getByPlaceholderText('노트 검색'), '영어');
    await waitFor(() => expect(screen.queryByText('수학 폴더')).toBeNull());
    expect(screen.getByText('영어 폴더')).toBeTruthy();
  });

  it('폴더를 누르면 그 폴더를 고른 2단계 화면으로 간다', async () => {
    await renderScreen(<QuizNotesScreen />);
    await fireEvent.press(await screen.findByText('수학 폴더'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/(tabs)/quiz/notes',
      params: { folderId: 'fA' },
    });
  });

  it('2단계는 제목이 폴더 이름이고, 그 폴더의 정리 끝난 자료만 보인다(자료 목록은 그 폴더 한 번만)', async () => {
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizNotesScreen />);
    expect(await screen.findByText('근의 공식 정리')).toBeTruthy();
    expect(screen.getByText('수학 폴더')).toBeTruthy();
    expect(screen.queryByText('어떤 노트로 퀴즈를 만들까요?')).toBeNull();
    // 정리 중인 자료 · 다른 폴더의 자료 · 다른 폴더 카드는 보이지 않는다
    expect(screen.queryByText('정리 중인 녹음')).toBeNull();
    expect(screen.queryByText('영어 단어장')).toBeNull();
    expect(screen.queryByText('영어 폴더')).toBeNull();
    expect(materials).toHaveBeenCalledTimes(1);
    expect(materials).toHaveBeenCalledWith('fA');
  });

  it('2단계에서 자료를 고르면 지금과 같은 퀴즈 만들기(/play/gen)로 간다', async () => {
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizNotesScreen />);
    await fireEvent.press(await screen.findByText('근의 공식 정리'));
    expect(router.push).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('이 노트로 퀴즈 만들기'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/play/gen',
      params: { materialId: 'mA1', title: '근의 공식 정리' },
    });
  });

  it('2단계에서 뒤로 가면 1단계(이전 화면)로 돌아간다', async () => {
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizNotesScreen />);
    await screen.findByText('근의 공식 정리');
    await fireEvent.press(screen.getByLabelText('뒤로'));
    expect(router.back).toHaveBeenCalledTimes(1);
  });

  it('정리 끝난 자료가 없는 폴더는 지금의 빈 상태를 보인다', async () => {
    setParams({ folderId: 'fC' });
    await renderScreen(<QuizNotesScreen />);
    expect(await screen.findByText('아직 노트가 없어요')).toBeTruthy();
    expect(screen.getByText('노트 올리러 가기')).toBeTruthy();
    expect(screen.queryByText('아직 정리 중인 문서')).toBeNull();
  });

  // code-review 1차: 노트 탭 폴더 화면처럼, 자료가 0개인 폴더의 목록 404는 실패가 아니라 빈 폴더다
  it('자료가 0개인 폴더의 자료 목록이 404면 오류가 아니라 빈 상태를 보인다', async () => {
    jest.spyOn(api.content, 'folders').mockResolvedValue([folder('fD', '새 폴더', 0)] as never);
    materials.mockRejectedValue(new ApiError('NOT_FOUND', '없어요', 404));
    setParams({ folderId: 'fD' });
    await renderScreen(<QuizNotesScreen />);
    expect(await screen.findByText('아직 노트가 없어요')).toBeTruthy();
    expect(screen.queryByText('문제가 생겼어요')).toBeNull();
  });

  // code-review 2차: 폴더 목록보다 자료 목록 404가 먼저 와도 오류를 잠깐 보이지 않는다
  it('폴더 목록을 읽는 중에 자료 목록이 404면 오류를 보이지 않고, 폴더가 오면 빈 상태를 보인다', async () => {
    let resolve!: (v: unknown) => void;
    jest.spyOn(api.content, 'folders').mockReturnValue(new Promise((r) => (resolve = r)) as never);
    materials.mockRejectedValue(new ApiError('NOT_FOUND', '없어요', 404));
    setParams({ folderId: 'fD' });
    await renderScreen(<QuizNotesScreen />);
    await waitFor(() => expect(materials).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('문제가 생겼어요')).toBeNull();
    resolve([folder('fD', '새 폴더', 0)]);
    expect(await screen.findByText('아직 노트가 없어요')).toBeTruthy();
    expect(screen.queryByText('문제가 생겼어요')).toBeNull();
  });

  // code-review 2차: 폴더 목록 오류와 빈 상태를 같이 보이지 않는다
  it('2단계에서 폴더 목록 오류가 나면 빈 상태는 보이지 않는다', async () => {
    jest.spyOn(api.content, 'folders').mockRejectedValue(new ApiError('INTERNAL', '실패', 500));
    setParams({ folderId: 'fC' });
    await renderScreen(<QuizNotesScreen />);
    expect(await screen.findByText('문제가 생겼어요')).toBeTruthy();
    await waitFor(() => expect(materials).toHaveBeenCalled());
    expect(screen.queryByText('아직 노트가 없어요')).toBeNull();
  });

  // code-review 3차: 폴더 목록 오류가 나면 오류와 고를 수 있는 자료 카드를 같이 보이지 않는다  it('2단계에서 폴더 목록 오류가 나면 자료 카드도 보이지 않는다', async () => {    jest.spyOn(api.content, 'folders').mockRejectedValue(new ApiError('INTERNAL', '실패', 500));    setParams({ folderId: 'fA' });    await renderScreen(<QuizNotesScreen />);    expect(await screen.findByText('문제가 생겼어요')).toBeTruthy();    await waitFor(() => expect(materials).toHaveBeenCalled());    await new Promise((r) => setTimeout(r, 50));    expect(screen.queryByText('근의 공식 정리')).toBeNull();  });
  // code-review 3차: 폴더 목록 오류가 나면 오류와 고를 수 있는 자료 카드를 같이 보이지 않는다
  it('2단계에서 폴더 목록 오류가 나면 자료 카드도 보이지 않는다', async () => {
    jest.spyOn(api.content, 'folders').mockRejectedValue(new ApiError('INTERNAL', '실패', 500));
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizNotesScreen />);
    expect(await screen.findByText('문제가 생겼어요')).toBeTruthy();
    await waitFor(() => expect(materials).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('근의 공식 정리')).toBeNull();
  });

  // code-review 1차: 2단계 제목 · 과목은 폴더 목록에서 오므로, 폴더 목록을 못 읽으면 오류를 보인다
  it('2단계에서 폴더 목록을 못 읽으면 오류를 보이고 다시 시도하면 둘 다 다시 읽는다', async () => {
    const folders = jest
      .spyOn(api.content, 'folders')
      .mockRejectedValueOnce(new ApiError('INTERNAL', '실패', 500));
    setParams({ folderId: 'fA' });
    await renderScreen(<QuizNotesScreen />);
    expect(await screen.findByText('문제가 생겼어요')).toBeTruthy();
    await fireEvent.press(screen.getByText('다시 시도'));
    expect(await screen.findByText('수학 폴더')).toBeTruthy();
    expect(folders).toHaveBeenCalledTimes(2);
  });
});

// 유사 퀴즈는 이 화면에서 풀지 않고, 다 만들면 일반 퀴즈처럼 풀이 화면에서 푼다(정답 · 해설은 결과 화면)
describe('유사 퀴즈 풀기', () => {
  afterEach(() => jest.restoreAllMocks());

  it('다 만들면 문제를 늘어놓지 않고 풀이 화면으로 넘어가며, 퀴즈 목록을 다시 읽는다', async () => {
    jest.spyOn(api.quiz, 'similar').mockResolvedValue({
      _id: 'sim1',
      status: 'ready',
      questionCount: 1,
      questions: [
        {
          _id: 'q1',
          type: 'multiple_choice',
          prompt: '첫 문제',
          choices: ['가', '나'],
          answer: '나',
        },
      ],
    } as never);
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    setParams({ setId: 'qs1' });
    await renderScreen(<QuizSimilarScreen />, qc);
    await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/play/solve',
        params: { setId: 'sim1' },
      }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ['quiz-sets'] });
    expect(screen.queryByText('첫 문제')).toBeNull();
    expect(screen.queryByText('플래시카드 저장')).toBeNull();
  });
});

// PR #240 리뷰: 항목을 Animated.View로 감싼 뒤에도 2열 배치가 유지된다
it('노트 격자는 2열 폭을 목록 바로 아래 래퍼가 갖고, 카드는 래퍼를 채운다', async () => {
  mockDemo.seedFolder();
  const folders = await api.content.folders();
  const ms = (await Promise.all(folders.map((f) => api.content.materials(f._id)))).flat();
  const note = ms.find((m) => !m.processing || m.processing.status === 'done')!;
  setParams({ folderId: note.folderId });
  await renderScreen(<QuizNotesScreen />);
  // 노트 제목에서 위로 올라가며 각 칸의 className을 모은다
  type N = { parent: N | null; props: { className?: string } };
  const chain: string[] = [];
  let n: N | null = (await screen.findByText(note.title)) as unknown as N;
  for (; n; n = n.parent) chain.push(n.props.className ?? '');
  const wrapper = chain.findIndex((c) => c.includes('w-[48.5%]'));
  // 폭 래퍼는 줄바꿈 목록의 바로 아래 칸이고, 그 안의 카드는 래퍼를 꽉 채운다(비율 폭 없음)
  expect(chain[wrapper + 1]).toContain('flex-wrap');
  expect(chain[wrapper - 1]).toBe('w-full');
  expect(chain.slice(0, wrapper).some((c) => c.includes('48.5%'))).toBe(false);
});
