import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Pressable, isBackdrop, splitPressClass } from '../components/press';

const mockReduce = { value: false };
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: () => mockReduce.value,
}));
beforeEach(() => {
  mockReduce.value = false;
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

// 실기기 테스트: 대부분의 버튼이 눌러도 눌린 느낌이 없었다(공용 Btn · Chip · Card만 Tap으로 줄었다)
describe('눌림 모션 Pressable', () => {
  // Codex #507 재리뷰: 자식의 hitSlop은 부모 경계 밖에서 잡히지 않아, 감싸면 아이콘 버튼의 터치 영역이 줄었다
  it('hitSlop은 줄어드는 상자에도 같이 줘 아이콘 바깥 터치 영역을 지킨다', async () => {
    await render(
      <Pressable accessibilityLabel="뒤로" hitSlop={12} onPress={() => {}}>
        <Text>뒤로</Text>
      </Pressable>,
    );
    const inner = screen.getByLabelText('뒤로');
    expect(inner.props.hitSlop).toBe(12);
    let node = inner.parent;
    while (node && node.props.hitSlop === undefined) node = node.parent;
    expect(node?.props.hitSlop).toBe(12);
  });

  it('바깥 배치(여백 · 위치 · flex)는 줄어드는 상자로, 모양은 누르는 요소에 둔다', async () => {
    await render(
      <Pressable
        accessibilityLabel="버튼"
        className="mt-3 flex-1 rounded-xl bg-mint px-3"
        onPress={() => {}}
      >
        <Text>버튼</Text>
      </Pressable>,
    );
    expect(wrapped('버튼')).toBe(true);
    // 모양(배경 · 둥근 모서리 · 안쪽 여백)은 누르는 요소에 그대로 — 실제 앱에서 스타일이 빠지지 않는다
    expect(screen.getByLabelText('버튼').props.className).toBe('rounded-xl bg-mint px-3 grow');
  });

  it('배치 클래스를 나눈다', () => {
    expect(splitPressClass('absolute right-5 bottom-24 rounded-full bg-ink p-2')).toEqual([
      'absolute right-5 bottom-24',
      'rounded-full bg-ink p-2',
    ]);
    expect(splitPressClass('absolute inset-0 bg-white')).toEqual([
      'absolute inset-0',
      'bg-white grow',
    ]);
    expect(splitPressClass('w-20 h-10 bg-mint')).toEqual(['w-20', 'h-10 bg-mint']);
  });

  it('동작 줄이기 · 1을 주면 · 화면을 덮는 배경은 감싸지 않고 기본 Pressable 그대로 쓴다', async () => {
    await render(
      <>
        <Pressable accessibilityLabel="그대로" scaleTo={1} className="mt-3 bg-mint">
          <Text>그대로</Text>
        </Pressable>
        <Pressable accessibilityLabel="배경" className="absolute inset-0 bg-black/45" />
      </>,
    );
    expect(wrapped('그대로')).toBe(false);
    expect(screen.getByLabelText('그대로').props.className).toBe('mt-3 bg-mint');
    expect(wrapped('배경')).toBe(false);
    mockReduce.value = true;
    await render(
      <Pressable accessibilityLabel="줄이기 끔" className="mt-3">
        <Text>줄이기 끔</Text>
      </Pressable>,
    );
    expect(wrapped('줄이기 끔')).toBe(false);
  });

  it('화면을 덮는 어두운 배경인지 가린다', () => {
    expect(isBackdrop('absolute inset-0 bg-black/45')).toBe(true);
    expect(isBackdrop('flex-1 bg-black/45')).toBe(true);
    expect(isBackdrop('absolute top-2 right-3 rounded-full bg-black/40 px-2')).toBe(false);
    expect(isBackdrop('flex-1 bg-mint')).toBe(false);
    expect(isBackdrop(undefined)).toBe(false);
  });
});
