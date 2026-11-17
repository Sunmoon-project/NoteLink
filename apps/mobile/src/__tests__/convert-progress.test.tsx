import { act, renderHook } from '@testing-library/react-native';
import { useSmoothProgress } from '../hooks/smooth-progress';

const mockReduced = { value: false };
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual('react-native-reanimated/mock'),
  useReducedMotion: () => mockReduced.value,
}));

beforeEach(() => {
  jest.useFakeTimers();
  mockReduced.value = false;
});
afterEach(() => jest.useRealTimers());

it('서버 진행률이 뛰어도 표시는 부드럽게 따라가고, 기다리는 동안은 목표 + 4%까지만 차오른다', async () => {
  const { result, rerender } = await renderHook(({ v }: { v: number }) => useSmoothProgress(v), {
    initialProps: { v: 15 },
  });
  await rerender({ v: 60 });
  await act(async () => jest.advanceTimersByTime(100));
  const mid = result.current;
  expect(mid).toBeGreaterThan(15);
  expect(mid).toBeLessThan(60); // 한 번에 뛰지 않음
  await act(async () => jest.advanceTimersByTime(3000));
  expect(result.current).toBeGreaterThanOrEqual(59.7);
  // 서버 값이 멈춰 있어도 아주 천천히 차오르되 64%를 넘지 않음
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(result.current).toBeGreaterThan(60);
  expect(result.current).toBeLessThanOrEqual(64);
});

it('목표가 줄면(다시 시도) 바로 맞추고, 0%에서는 혼자 차오르지 않는다', async () => {
  const { result, rerender } = await renderHook(({ v }: { v: number }) => useSmoothProgress(v), {
    initialProps: { v: 80 },
  });
  await rerender({ v: 0 });
  await act(async () => jest.advanceTimersByTime(5000));
  expect(result.current).toBe(0);
});

it('동작 줄이기를 켜면 서버 값을 그대로 보인다', async () => {
  mockReduced.value = true;
  const { result, rerender } = await renderHook(({ v }: { v: number }) => useSmoothProgress(v), {
    initialProps: { v: 10 },
  });
  await rerender({ v: 70 });
  expect(result.current).toBe(70);
});
