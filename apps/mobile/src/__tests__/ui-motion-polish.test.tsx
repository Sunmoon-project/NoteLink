import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { withSpring } from 'react-native-reanimated';
import { Progress, Tap } from '../components/ui';
import { AppOverlays } from '../components/AppOverlays';
import { useToast } from '../stores/toast';

const mockReduce = { value: false };
jest.mock('react-native-reanimated', () => {
  const real = jest.requireActual('react-native-reanimated/mock');
  return {
    ...real,
    useReducedMotion: () => mockReduce.value,
    withSpring: jest.fn((v: number) => v),
  };
});
// 기본 Pressable을 props가 그대로 보이는 View로 바꾼다(onPressIn을 직접 부르려고)
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const { forwardRef, createElement } = jest.requireActual('react');
  const Pressable = forwardRef(({ style, ...p }: { style?: unknown }, ref: unknown) =>
    createElement(RN.View, {
      ...p,
      ref,
      style: typeof style === 'function' ? style({ pressed: false }) : style,
    }),
  );
  return Object.defineProperty(RN, 'Pressable', { value: Pressable });
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
beforeEach(() => {
  mockReduce.value = false;
  jest.mocked(withSpring).mockClear();
});

/** 줄어드는 상자로 감쌌는지: 누르는 요소의 바깥에 transform이 있는 상자가 있다 */
const wrapped = (label: string) => {
  let node = screen.getByLabelText(label).parent;
  while (node) {
    const style = [node.props.style].flat(Infinity) as ({ transform?: unknown } | undefined)[];
    if (style.some((s) => s && 'transform' in s)) return true;
    node = node.parent;
  }
  return false;
};

// UI · 모션 점검 6: 공용 Tap(Btn · Card · Chip)이 동작 줄이기 · 비활성 · hitSlop을 무시했다
describe('공용 Tap', () => {
  it('동작 줄이기를 켜면 줄어드는 상자로 감싸지 않는다', async () => {
    mockReduce.value = true;
    await render(
      <Tap accessibilityLabel="저장" onPress={jest.fn()}>
        <Text>저장</Text>
      </Tap>,
    );
    expect(wrapped('저장')).toBe(false);
    expect(screen.getByLabelText('저장')).toHaveStyle({ minWidth: 44, minHeight: 44 });
  });

  it('비활성이면 눌러도 줄지 않는다', async () => {
    await render(
      <Tap accessibilityLabel="저장" disabled onPress={jest.fn()}>
        <Text>저장</Text>
      </Tap>,
    );
    // fireEvent는 비활성 요소의 이벤트를 막아서, 손가락이 닿는 순간의 핸들러를 직접 부른다(아래 Pressable 대역)
    await act(async () => screen.getByLabelText('저장').props.onPressIn({}));
    expect(withSpring).not.toHaveBeenCalled();
  });

  it('hitSlop을 줄어드는 상자에도 줘 넓힌 터치 영역이 잘리지 않는다', async () => {
    await render(
      <Tap accessibilityLabel="칩" hitSlop={8} onPress={jest.fn()}>
        <Text>칩</Text>
      </Tap>,
    );
    let node = screen.getByLabelText('칩').parent;
    while (node && node.props.hitSlop === undefined) node = node.parent;
    expect(node?.props.hitSlop).toBe(8);
  });
});

// UI · 모션 점검 2: scaleX는 둥근 끝을 납작하게 눌렀다
it('진행 막대는 가로로 줄이지 않고 왼쪽에서 밀어 넣는다', async () => {
  await render(<Progress value={30} />);
  // 진행 막대 바탕(progressbar)은 접근성 요소가 아니라 역할로 찾지 못해 뿌리에서 바로 꺼낸다
  const fill = screen.root?.children[0];
  const style = StyleSheet.flatten(typeof fill === 'string' ? undefined : fill?.props.style) as {
    transform?: object[];
  };
  expect(style.transform).toEqual([{ translateX: '-70%' }]);
});

// UI · 모션 점검 16: 연달아 띄우면 두 번째 토스트는 모션 없이 글자만 바뀌었다
it('토스트를 연달아 띄우면 같은 글이어도 새로 들어온다', async () => {
  await render(<AppOverlays />);
  await act(async () => useToast.getState().show('저장했어요'));
  const first = screen.getByText('저장했어요');
  await act(async () => useToast.getState().show('저장했어요'));
  expect(screen.getByText('저장했어요')).not.toBe(first);
  await act(async () => useToast.getState().hide());
});
