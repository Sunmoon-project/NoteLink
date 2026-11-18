import { fireEvent, screen } from '@testing-library/react-native';
import SharedStudyItemScreen from '../../app/room/shared';
import { renderScreen, setParams } from '../test-utils';

const mockSharedItem = jest.fn();
jest.mock('../lib/api', () => ({
  api: { rooms: { sharedItem: (...args: unknown[]) => mockSharedItem(...args) } },
}));

beforeEach(() => {
  mockSharedItem.mockReset();
  setParams({ id: 'room1', itemId: 'share1' });
});

it('공유 퀴즈의 문제를 보여 주고 정답을 선택적으로 펼친다', async () => {
  mockSharedItem.mockResolvedValue({
    itemType: 'quiz',
    quiz: {
      title: '과학 퀴즈',
      questions: [{ _id: 'q1', prompt: '물의 기호는?', choices: ['H2O', 'O2'], answer: 'H2O' }],
    },
  });
  await renderScreen(<SharedStudyItemScreen />);
  expect(await screen.findByText('과학 퀴즈')).toBeTruthy();
  expect(screen.queryByText('정답: H2O')).toBeNull();
  await fireEvent.press(screen.getByText('정답 보기'));
  expect(screen.getByText('정답: H2O')).toBeTruthy();
  expect(mockSharedItem).toHaveBeenCalledWith('room1', 'share1');
});

it('공유 카드의 현재 면을 접근성 라벨로 읽고 뒤집는다', async () => {
  mockSharedItem.mockResolvedValue({
    itemType: 'flashcards',
    cards: [{ front: '문제', back: '답' }],
  });
  await renderScreen(<SharedStudyItemScreen />);
  await fireEvent.press(
    await screen.findByRole('button', { name: '문제: 문제. 눌러서 카드를 뒤집기' }),
  );
  expect(screen.getByRole('button', { name: '정답: 답. 눌러서 카드를 뒤집기' })).toBeTruthy();
});
