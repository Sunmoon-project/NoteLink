import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Roll, RollUp, Segment, Swap } from '../components/ui';

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

it('세그먼트는 바깥 상자 폭으로 칸 폭을 재 고른 칸 판을 그린다 (재기 전에는 칸 자체를 칠한다)', async () => {
  await render(
    <Segment items={['전체 공개', '비는 시간만'] as const} value="전체 공개" onChange={() => {}} />,
  );
  const tab = screen.getAllByRole('tab')[0]!;
  expect(tab.props.className).toContain('bg-brand');
  await fireEvent(tab.parent!, 'layout', { nativeEvent: { layout: { width: 208, height: 48 } } });
  // 판이 생기면 칸은 칠하지 않고, 판 폭은 (208 - 8) / 2
  expect(screen.getAllByRole('tab')[0]!.props.className).not.toContain('bg-brand');
  const thumb = tab.parent!.children[0] as unknown as { props: { style: unknown } };
  expect(JSON.stringify(thumb.props.style)).toContain('"width":100');
});

it('RollUp은 시작값을 보여 주다가 한 박자 뒤 값으로 굴린다', async () => {
  jest.useFakeTimers();
  await render(<RollUp value="+28P" from="+0P" />);
  expect(screen.getByText('+0P')).toBeTruthy();
  await act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByText('+28P')).toBeTruthy();
  jest.useRealTimers();
});
