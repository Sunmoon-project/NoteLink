// 녹음 자막 화면: 한 문장 + 다음 문장 미리보기(한 줄), 동작 줄이기면 이동 없이 투명도만
import { act, render, screen } from '@testing-library/react-native';
import { useSharedValue } from 'react-native-reanimated';
import { Captions } from '../features/content/captions-view';
import { splitLines } from '../features/content/captions';

let mockReduced = false;
// 프레임 시계 반응(문장 넘김)을 시험에서 직접 부르고, 넘김 묶음(LayoutAnimationConfig)이 몇 번 새로 붙는지 센다
const mockReact: { fn?: (now: number, prev: number | null) => void } = {};
const mockMounts = { n: 0 };
jest.mock('react-native-reanimated', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    ...jest.requireActual('react-native-reanimated/mock'),
    useReducedMotion: () => mockReduced,
    useAnimatedReaction: (_: unknown, fn: (now: number, prev: number | null) => void) => {
      mockReact.fn = fn;
    },
    LayoutAnimationConfig: ({ children }: { children: React.ReactNode }) => {
      useEffect(() => {
        mockMounts.n++;
      }, []);
      return children;
    },
  };
});

const lines = splitLines([
  { startSec: 0, endSec: 2, text: '처음 짧은 구간' },
  { startSec: 3, endSec: 5, text: '두 번째 짧은 구간' },
  { startSec: 40, endSec: 50, text: '현재 긴 구간' },
]);

function At({ sec }: { sec: number }) {
  const clock = useSharedValue(sec);
  return <Captions lines={lines} clock={clock} pos={sec} />;
}

beforeEach(() => {
  mockReduced = false;
  mockMounts.n = 0;
});

it.each([
  { sec: 1, now: '처음 짧은 구간', next: '두 번째 짧은 구간' },
  { sec: 42, now: '현재 긴 구간', next: null },
  { sec: 20, now: '현재 긴 구간', next: null }, // 빈 구간은 다음 문장을 채움 0으로
])('$sec초: 지금 문장 하나와 다음 문장 미리보기만', async ({ sec, now, next }) => {
  await render(<At sec={sec} />);
  expect(screen.getByTestId('caption-now').props.children).toBe(now);
  if (next) {
    const n = screen.getByTestId('caption-next');
    expect(n.props.children).toBe(next);
    expect(n.props.numberOfLines).toBe(2); // 바뀌기 전 상자 길이에 가깝게 두 줄까지
    expect(n.props.accessibilityLabel).toBe(`다음 문장, ${next}`);
  } else expect(screen.queryByTestId('caption-next')).toBeNull();
  // 앞 문장은 어디에도 없다
  expect(screen.queryByText('처음 짧은 구간', { exact: true })).toBe(
    now === '처음 짧은 구간' ? screen.getByTestId('caption-now') : null,
  );
});

it('재생 위치가 바뀌면 그 문장으로 넘어간다', async () => {
  const view = await render(<At sec={1} />);
  await view.rerender(<At sec={4} />);
  expect(screen.getByTestId('caption-now').props.children).toBe('두 번째 짧은 구간');
});

it('문장을 넘길 때 위로 밀고(layout 전환), 동작 줄이기면 이동 없이 투명도만', async () => {
  const view = await render(<At sec={1} />);
  expect(screen.getByTestId('caption-row-0').props.layout).toBeDefined();
  mockReduced = true;
  await view.rerender(<At sec={1.5} />);
  expect(screen.getByTestId('caption-row-0').props.layout).toBeUndefined();
  expect(screen.getByTestId('caption-row-0').props.exiting).toBeDefined();
});

it('프레임 시계가 먼저 넘긴 뒤 재생 상태가 따라와도 넘김 애니메이션을 끊지 않는다', async () => {
  const view = await render(<At sec={1.9} />);
  expect(mockMounts.n).toBe(1);
  await act(async () => mockReact.fn!(1, 0)); // 2초를 넘는 순간(UI 스레드)
  expect(screen.getByTestId('caption-now').props.children).toBe('두 번째 짧은 구간');
  await view.rerender(<At sec={2.1} />); // 0.25초 뒤 상태
  expect(screen.getByTestId('caption-now').props.children).toBe('두 번째 짧은 구간');
  expect(mockMounts.n).toBe(1); // 다시 붙지 않음 = exit · layout 애니메이션이 이어 달린다
});

it('프레임 시계가 살짝 뒤로 가도(상태 기준점 흔들림) 앞 문장으로 돌아가지 않고, 되감기는 재생 위치로 따른다', async () => {
  const view = await render(<At sec={3.1} />);
  await act(async () => mockReact.fn!(0, 1));
  expect(screen.getByTestId('caption-now').props.children).toBe('두 번째 짧은 구간');
  await view.rerender(<At sec={1} />); // 되감기
  expect(screen.getByTestId('caption-now').props.children).toBe('처음 짧은 구간');
});

it('짧은 문장이어도 자막 상자가 줄어들지 않게 최소 높이(4줄)를 둔다', async () => {
  await render(<At sec={1} />);
  expect(screen.getByTestId('captions').props.style).toEqual(
    expect.objectContaining({ minHeight: 112 }),
  );
});

it('가독성: 안 읽은 글 · 미리보기도 어두운 배경에서 읽히는 밝기, 줄 간격은 넉넉하게', async () => {
  await render(<At sec={1} />);
  const now = String(screen.getByTestId('caption-now').props.className);
  expect(now).toContain('text-white/60');
  expect(now).toContain('leading-7');
  expect(now).not.toContain('font-semibold');
  expect(String(screen.getByTestId('caption-next').props.className)).toContain('text-white/45');
});

it('지금 문장이 구간의 마지막이면 다음 구간의 첫 문장(then)을 미리 보인다', async () => {
  function Last() {
    const clock = useSharedValue(42);
    const [then] = splitLines([{ startSec: 60, endSec: 62, text: '다음 구간 첫 문장' }]);
    return <Captions lines={lines} clock={clock} pos={42} then={then} />;
  }
  await render(<Last />);
  expect(screen.getByTestId('caption-next').props.children).toBe('다음 구간 첫 문장');
});

// 검증 지적: 시작 시각이 같은 문장 둘이면 key가 겹쳐 한 줄이 사라지거나 엉뚱한 줄이 애니메이션된다
it('시작 시각이 같은 문장이 둘이어도 key가 겹치지 않는다', async () => {
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  const same = splitLines([
    { startSec: 1, endSec: 2, text: '같은 시각 하나' },
    { startSec: 1, endSec: 3, text: '같은 시각 둘' },
  ]);
  // 첫 문장 전(빈 구간)이면 지금 자리에 첫 문장, 미리보기에 같은 시각의 둘째 문장이 함께 온다
  function Same() {
    const clock = useSharedValue(0.5);
    return <Captions lines={same} clock={clock} pos={0.5} />;
  }
  await render(<Same />);
  expect(screen.getByTestId('caption-now')).toBeTruthy();
  expect(screen.getByTestId('caption-next')).toBeTruthy();
  expect(err.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
  err.mockRestore();
});
