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
// 자막 옆 3D 아바타 선생님: 받은 값(표정 · 입 모양 함수)만 적어 둔다
const mockAvatar: { props?: Record<string, unknown> } = {};
jest.mock('../features/tutor/avatar3d', () => ({
  Avatar3D: (props: Record<string, unknown>) => {
    mockAvatar.props = props;
    return null;
  },
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

// 사용자 요청: 배속 칩도 작아 누르기 불편했다 → 보이는 크기 + hitSlop으로 누르는 높이 44pt 이상, 글자 한 단계 키움
it('배속 칩은 누르는 높이가 44pt 이상이고 글자는 caption이다', async () => {
  await renderScreen(<Player materialId="m-rate" />);
  const label = await screen.findByText(/배속/);
  expect(String(label.props.className)).toMatch(/\btext-caption\b/);
  let node = label.parent;
  while (node && node.props.hitSlop === undefined) node = node.parent;
  const cls = [node, node?.parent].map((n) => String(n?.props.className ?? '')).join(' ');
  const h = Number(cls.match(/\bh-(\d+)\b/)?.[1]) * 4;
  const slop = Number(node?.props.hitSlop?.top ?? node?.props.hitSlop);
  expect(h + slop * 2).toBeGreaterThanOrEqual(44);
});

// 사용자 요청: 2D 초록 얼굴 대신 3D 아바타 선생님이 실제 말에 맞춰 입을 움직인다
it('자막 옆에 3D 아바타 선생님(얼굴 전체가 보이는 구도 64)을 띄우고 입 모양 함수를 넘긴다', async () => {
  await renderScreen(<Player materialId="m-avatar" />);
  await screen.findByLabelText('일시정지');
  expect(screen.queryByLabelText('아바타')).toBeNull(); // 옛 2D 얼굴
  expect(mockAvatar.props).toMatchObject({ mood: 'talking', framing: 'full', size: 64 });
  const lips = (mockAvatar.props!.lips as () => { open: number; wide: number })();
  expect(lips).toEqual({ open: 0, wide: 1 }); // 대본이 없으면 입을 다문다
});
