import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { QuizNotesScreen, QuizSimilarScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { mockDemo } from './fixtures/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));

// PR #39 리뷰
describe('퀴즈 만들 노트 고르기', () => {
  it('폴더가 아니라 노트(자료) ID로 퀴즈를 만든다', async () => {
    mockDemo.seedFolder();
    const folders = await api.content.folders();
    const ms = (await Promise.all(folders.map((f) => api.content.materials(f._id)))).flat();
    const note = ms.find((m) => !m.processing || m.processing.status === 'done')!;
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
