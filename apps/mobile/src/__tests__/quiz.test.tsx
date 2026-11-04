import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { QuizNotesScreen, QuizSimilarScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { mockDemo } from '../lib/mock/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
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

describe('유사 퀴즈 플래시카드 저장', () => {
  it('저장하면 플래시카드 목록 캐시를 갱신한다', async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    setParams({ setId: 'qs1' });
    await renderScreen(<QuizSimilarScreen />, qc);
    await fireEvent.press(screen.getByText('유사 퀴즈 만들기'));
    await fireEvent.press(
      (await screen.findAllByText('플래시카드 저장', {}, { timeout: 8000 }))[0]!,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['flashcards'] }));
  });
});
