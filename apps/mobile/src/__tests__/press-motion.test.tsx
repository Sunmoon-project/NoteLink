import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Pressable, isBackdrop } from '../components/press';

const mockReduce = { value: false };
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: () => mockReduce.value,
}));
beforeEach(() => {
  mockReduce.value = false;
});

/** 눌림 모션(줄이기 스타일)을 붙였는지: 원래 스타일 뒤에 애니메이션 스타일이 붙는다 */
const moves = (label: string) => Array.isArray(screen.getByLabelText(label).props.style);

// 실기기 테스트: 대부분의 버튼이 눌러도 눌린 느낌이 없었다(공용 Btn · Chip · Card만 Tap으로 줄었다)
describe('눌림 모션 Pressable', () => {
  it('기본 Pressable처럼 쓰고, 누르면 줄어드는 모션을 붙인다', async () => {
    await render(
      <Pressable accessibilityLabel="버튼" className="rounded-xl bg-mint px-3" onPress={() => {}}>
        <Text>버튼</Text>
      </Pressable>,
    );
    expect(moves('버튼')).toBe(true);
    // 감싸는 상자 없이 그 요소 그대로(배치가 바뀌지 않는다)
    expect(screen.getByLabelText('버튼').props.className).toBe('rounded-xl bg-mint px-3');
  });

  it('누를 수 없을 때 · 동작 줄이기를 켰을 때 · 1을 주면 줄지 않는다', async () => {
    await render(
      <>
        <Pressable accessibilityLabel="꺼짐" disabled>
          <Text>꺼짐</Text>
        </Pressable>
        <Pressable accessibilityLabel="그대로" scaleTo={1}>
          <Text>그대로</Text>
        </Pressable>
      </>,
    );
    expect(moves('꺼짐')).toBe(false);
    expect(moves('그대로')).toBe(false);
    mockReduce.value = true;
    await render(
      <Pressable accessibilityLabel="줄이기 끔">
        <Text>줄이기 끔</Text>
      </Pressable>,
    );
    expect(moves('줄이기 끔')).toBe(false);
  });

  it('화면을 덮는 어두운 배경은 줄이지 않는다', () => {
    expect(isBackdrop('absolute inset-0 bg-black/45')).toBe(true);
    expect(isBackdrop('flex-1 bg-black/45')).toBe(true);
    expect(isBackdrop('absolute top-2 right-3 rounded-full bg-black/40 px-2')).toBe(false);
    expect(isBackdrop('flex-1 bg-mint')).toBe(false);
    expect(isBackdrop(undefined)).toBe(false);
  });
});
