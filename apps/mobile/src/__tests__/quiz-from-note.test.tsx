import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { Material } from '@notelink/shared';
import { QuizFromNote } from '../features/content/quiz-from-note';
import { renderScreen } from '../test-utils';

const note = (status: string) =>
  ({ _id: 'm1', title: '광합성', processing: { status } }) as unknown as Material;

beforeEach(() => jest.mocked(router.push).mockClear());

it.each(['pending', 'processing', 'failed'])(
  '정리가 끝나지 않은 노트(%s)에는 보이지 않는다',
  async (s) => {
    await renderScreen(<QuizFromNote material={note(s)} />);
    expect(screen.queryByText('이 노트로 퀴즈 풀기')).toBeNull();
  },
);

it('정리가 끝난 노트는 눌러서 그 노트로 퀴즈 만들기 화면을 연다', async () => {
  await renderScreen(<QuizFromNote material={note('done')} />);
  fireEvent.press(screen.getByText('이 노트로 퀴즈 풀기'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/play/gen',
    params: { materialId: 'm1', title: '광합성' },
  });
});
