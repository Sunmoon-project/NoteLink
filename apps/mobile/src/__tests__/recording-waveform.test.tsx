import { render, screen } from '@testing-library/react-native';
import { Easing, ReduceMotion, withTiming } from 'react-native-reanimated';
import { BAR_COUNT, WAVE_MAX_W, Waveform } from '@/features/content/capture';

// 줄을 흘리는 애니메이션 호출을 세기 위해 withTiming만 감싼다
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, withTiming: jest.fn(actual.withTiming) };
});

jest.mock('expo-router', () => ({
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

it('상자 폭이 아무리 넓어도 양 끝 막대는 늘 상자 밖에 있다', async () => {
  // 가운데 놓인 줄(막대 6 · 사이 4)이 한 칸(10) 밀려도, 맨 끝 막대 안쪽 모서리가 상자 밖이어야 한다
  const row = BAR_COUNT * 6 + (BAR_COUNT - 1) * 4;
  expect(WAVE_MAX_W / 2).toBeLessThanOrEqual(row / 2 - 10 - 6);
  // 가장 넓은 폰(440pt - 양옆 여백 40)도 최대 폭 안에 들어 상자가 줄어들지 않는다
  expect(WAVE_MAX_W).toBeGreaterThanOrEqual(400);
  await render(<Waveform bars={Array(BAR_COUNT).fill(6)} live />);
  expect(screen.toJSON()).toHaveStyle({ maxWidth: WAVE_MAX_W });
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
