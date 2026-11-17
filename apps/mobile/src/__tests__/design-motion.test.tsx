import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Roll, RollUp, Segment, Swap } from '../components/ui';

jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  router: { back: jest.fn() },
  useSegments: () => [],
}));

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

it('Roll은 한 줄 높이를 잰 뒤 숫자를 자리별로 굴리고, 9 → 10처럼 자릿수가 늘어도 1의 자리를 이어 굴린다', async () => {
  const { rerender } = await render(<Roll value={9} />);
  // 재기 전에는 글자 그대로 그린다
  expect(screen.queryAllByText('0')).toHaveLength(0);
  await fireEvent(screen.getAllByText('9')[0]!, 'layout', {
    nativeEvent: { layout: { width: 10, height: 20 } },
  });
  // 잰 뒤에는 자리마다 0~9 기둥을 그리고, 그 자리 숫자만큼 위로 옮겨 둔다
  const column = (digit: string) =>
    screen.getAllByText(digit).filter((t) => t.parent?.children.length === 10);
  expect(column('5')).toHaveLength(1);
  const ones = column('0')[0]!.parent!;
  expect(JSON.stringify(ones.props.style)).toContain('-180');
  await rerender(<Roll value={10} />);
  expect(screen.getByLabelText('10')).toBeTruthy();
  // 자리가 둘이 되고, 1의 자리 기둥은 같은 것을 이어 쓰며 0으로 굴러간다
  expect(column('5')).toHaveLength(2);
  expect(column('0').map((t) => t.parent)).toContain(ones);
  expect(JSON.stringify(ones.props.style)).toContain('"translateY":0');
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
