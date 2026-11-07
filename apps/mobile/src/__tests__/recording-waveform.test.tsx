import { render, screen } from '@testing-library/react-native';
import { BAR_COUNT, Waveform } from '@/features/content/capture';

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

it('파형 줄은 가장 넓은 폰의 상자보다 넓어 양 끝 막대가 상자 밖에서 들고 난다', () => {
  // 440pt 폰 - 양옆 여백 40 = 상자 400. 한 칸 밀어도(−10) 상자를 덮어야 한다
  expect(BAR_COUNT * 10 - 10).toBeGreaterThanOrEqual(400);
});

it('녹음 중에는 소리 크기대로, 멈추면 모든 막대를 바닥 높이로 그린다', async () => {
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => 6 + (i % 5) * 8);
  const { rerender } = await render(<Waveform bars={bars} live />);
  expect(heights()).toEqual(bars);
  await rerender(<Waveform bars={bars} live={false} />);
  expect(heights().every((h) => h === 6)).toBe(true);
});
