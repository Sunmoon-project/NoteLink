import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Roll, Swap } from '../components/ui';

jest.mock('expo-router', () => ({ router: { back: jest.fn() }, useSegments: () => [] }));

it('Swap은 키가 바뀌면 옛 내용을 잠깐 두었다가 새 내용으로 바꾼다', async () => {
  jest.useFakeTimers();
  const ui = (k: string) => (
    <Swap k={k}>
      <Text>{k}</Text>
    </Swap>
  );
  const { rerender } = await render(ui('재생'));
  await rerender(ui('일시정지'));
  expect(screen.getByText('재생')).toBeTruthy();
  await act(() => jest.advanceTimersByTime(200));
  expect(screen.getByText('일시정지')).toBeTruthy();
  expect(screen.queryByText('재생')).toBeNull();
  jest.useRealTimers();
});

it('Roll은 값 전체를 한 번에 읽히고 Text처럼 찾을 수 있으며, 숫자 아닌 글자는 그대로 둔다', async () => {
  await render(<Roll value="1,240" />);
  expect(screen.getByLabelText('1,240')).toBeTruthy();
  expect(screen.getByText('1,240')).toBeTruthy();
  expect(screen.getByText(',')).toBeTruthy();
});
