import { act, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Player } from '../features/content/player';
import { renderScreen } from '../test-utils';

const mockPause = jest.fn();
const mockStatus = { currentTime: 10, duration: 200, playing: true, playbackRate: 1 };
jest.mock('../lib/api', () => ({
  api: {
    content: {
      recording: jest.fn(async () => ({
        audioUrl: 'https://blob.example/audio.m4a',
        durationSec: 200,
        slides: [],
        transcript: { text: '', segments: [] },
      })),
      material: jest.fn(async () => ({ bookmarks: [] })),
    },
  },
}));
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({
    loop: false,
    play: jest.fn(),
    pause: mockPause,
    seekTo: jest.fn(),
    setPlaybackRate: jest.fn(),
  }),
  useAudioPlayerStatus: () => mockStatus,
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

afterEach(() => {
  globalThis.mockFocused = undefined;
  mockPause.mockClear();
});

// 사용자 신고: 녹음을 재생하면서 다른 탭으로 넘어가면 재생이 멈추지 않고 계속 들렸다.
// 탭 안의 스택 화면은 탭을 바꿔도 내려가지 않아(언마운트되지 않아) 플레이어가 그대로 살아 있었다
it('재생 중에 화면이 가려지면(탭 이동 · 다른 화면) 일시정지한다', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await renderScreen(<Player materialId="m-focus" />, qc);
  await screen.findByLabelText('일시정지');
  expect(mockPause).not.toHaveBeenCalled();
  globalThis.mockFocused = false;
  await act(async () =>
    view.rerender(
      <SafeAreaProvider>
        <QueryClientProvider client={qc}>
          <Player materialId="m-focus" />
        </QueryClientProvider>
      </SafeAreaProvider>,
    ),
  );
  expect(mockPause).toHaveBeenCalled();
});

// 사용자 요청: 재생 화면 아래 북마크 · 넘김 버튼이 작아 누르기 불편했다(40pt)
it.each(['북마크 추가', '5초 뒤로', '5초 앞으로', '구간 반복'])(
  '「%s」 버튼은 최소 44pt 크기다',
  async (label) => {
    await renderScreen(<Player materialId="m-size" />);
    // 눌림 Pressable은 폭(w-)을 바깥 상자로, 높이(h-)를 누르는 요소에 나눠 둔다 → 둘 다 모아 본다
    const node = await screen.findByLabelText(label);
    const cls = [node, node.parent, node.parent?.parent]
      .map((n) => String(n?.props.className ?? ''))
      .join(' ');
    const [h, w] = [/\bh-(\d+)\b/, /\bw-(\d+)\b/].map((re) => Number(cls.match(re)?.[1]) * 4);
    expect(h).toBeGreaterThanOrEqual(44);
    expect(w).toBeGreaterThanOrEqual(44);
  },
);
