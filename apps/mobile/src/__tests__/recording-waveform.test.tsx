import { render, screen } from '@testing-library/react-native';
import { StyleSheet, type ViewStyle } from 'react-native';
import { Easing, ReduceMotion, withTiming } from 'react-native-reanimated';
import { BAR_COUNT, BAR_STEP, WAVE_MAX_W, Waveform } from '@/features/content/capture';

// 줄을 흘리는 애니메이션 호출을 세기 위해 withTiming만 감싼다
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, withTiming: jest.fn(actual.withTiming) };
});

jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  router: { back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
}));
jest.mock('../lib/api', () => ({ api: {} }));
jest.mock('../lib/upload', () => ({ checkFile: jest.fn(), uploadToBlob: jest.fn() }));
jest.mock('../lib/image-edit', () => ({ editPhoto: jest.fn() }));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-audio', () => ({
  AudioModule: {},
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
}));

type Node = { children?: Node[]; props: { style?: { height?: number } } };
const heights = () =>
  ((screen.toJSON() as unknown as Node).children![0]!.children ?? []).map(
    (b) => b.props.style?.height,
  );

beforeEach(() => jest.mocked(withTiming).mockClear());

it('상자 폭이 아무리 넓어도 양 끝 막대는 늘 상자 밖에 있다 (화면에 실제로 적용된 크기로 계산)', async () => {
  await render(<Waveform bars={Array(BAR_COUNT).fill(6)} live />);
  type StyledNode = { children?: StyledNode[]; props: { style?: unknown } };
  const flat = (n: StyledNode): ViewStyle => StyleSheet.flatten(n.props.style as ViewStyle) ?? {};
  const box = screen.toJSON() as unknown as StyledNode;
  const row = box.children![0]!;
  const bars = row.children!;
  // 클래스(rem 기준)가 아니라 숫자로 적용된 막대 폭 · 간격 · 상자 최대 폭을 읽는다
  const barW = flat(bars[0]!).width as number;
  const gap = flat(row).gap as number;
  const maxW = flat(box).maxWidth as number;
  expect(bars.every((b) => flat(b).width === barW)).toBe(true);
  const rowW = bars.length * barW + (bars.length - 1) * gap;
  // 한 번에 흐르는 거리가 실제 한 칸과 같아야 갱신마다 위치가 튀지 않는다
  expect(BAR_STEP).toBe(barW + gap);
  // 가운데 놓인 줄이 한 칸 밀려도 맨 끝 막대 안쪽 모서리가 상자 밖이어야 한다
  expect(maxW).toBe(WAVE_MAX_W);
  expect(maxW / 2).toBeLessThanOrEqual(rowW / 2 - BAR_STEP - barW);
  // 가장 넓은 폰(440pt - 양옆 여백 40)은 최대 폭 안에 들어 상자가 줄어들지 않는다
  expect(maxW).toBeGreaterThanOrEqual(400);
});

it('새 소리 크기가 들어올 때마다 한 칸 거리를 일정한 속도로 다시 흘리고, 멈춘 동안은 흘리지 않는다', async () => {
  const at = (n: number) => Array.from({ length: BAR_COUNT }, (_, i) => 6 + ((i + n) % 5) * 8);
  const { rerender } = await render(<Waveform bars={at(0)} live />);
  expect(withTiming).toHaveBeenCalledTimes(1);
  // 동작 줄이기는 시스템 설정을 따르고, 폴링 간격(120ms) 동안 선형으로 흐른다
  expect(withTiming).toHaveBeenLastCalledWith(0, {
    duration: 120,
    easing: Easing.linear,
    reduceMotion: ReduceMotion.System,
  });
  await rerender(<Waveform bars={at(1)} live />);
  expect(withTiming).toHaveBeenCalledTimes(2);
  // 일시정지: 값이 바뀌어도 흘리지 않는다
  await rerender(<Waveform bars={at(1)} live={false} />);
  await rerender(<Waveform bars={at(2)} live={false} />);
  expect(withTiming).toHaveBeenCalledTimes(2);
  // 다시 녹음하면 바로 이어서 흐른다
  await rerender(<Waveform bars={at(2)} live />);
  expect(withTiming).toHaveBeenCalledTimes(3);
  await rerender(<Waveform bars={at(3)} live />);
  expect(withTiming).toHaveBeenCalledTimes(4);
});

it('녹음 중에는 소리 크기대로, 멈추면 모든 막대를 바닥 높이로 그린다', async () => {
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => 6 + (i % 5) * 8);
  const { rerender } = await render(<Waveform bars={bars} live />);
  expect(heights()).toEqual(bars);
  await rerender(<Waveform bars={bars} live={false} />);
  expect(heights().every((h) => h === 6)).toBe(true);
});
