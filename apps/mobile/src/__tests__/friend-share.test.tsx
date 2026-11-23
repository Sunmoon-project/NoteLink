import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { useOpenFriendShare } from '../features/content/friend-share';
import { HandDetailScreen, RecDetailScreen } from '../features/content/detail';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

// 친구에게 받은 · 보낸 노트(#554 PR 2): 1:1 채팅 카드로 열기 · 읽기 전용 · 내 노트로 복사 · 공유 끝내기 · 끝난 공유
const mockApi = {
  content: {
    material: jest.fn(),
    friendShare: jest.fn(),
    recording: jest.fn(),
    copyMaterial: jest.fn(),
    revokeFriendShare: jest.fn(),
    folders: jest.fn(),
  },
};
class MockApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  get ApiError() {
    return MockApiError;
  },
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({
    loop: false,
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    setPlaybackRate: jest.fn(),
  }),
  useAudioPlayerStatus: () => ({ currentTime: 0, duration: 60, playing: false, playbackRate: 1 }),
}));
jest.mock('../features/tutor/avatar3d', () => ({ Avatar3D: () => null }));
jest.mock('../lib/feature-navigation', () => ({
  useFeatureNavigation: () => (href: unknown) => {
    (jest.requireMock('expo-router') as { router: { push: (h: unknown) => void } }).router.push(
      href,
    );
    return true;
  },
}));

const share = {
  _id: 's1',
  materialId: 'n1',
  ownerId: 'u1',
  ownerNickname: '민지',
  friendId: 'me',
  title: '미적분 필기',
  kind: 'handwriting' as const,
  active: true,
  mine: false,
  createdAt: '2026-11-22T00:00:00.000Z',
};
const note = {
  _id: 'n1',
  folderId: 'f9',
  kind: 'handwriting',
  source: 'camera',
  title: '미적분 필기',
  processing: { status: 'done', progress: 100, jobId: null },
  summary: { sections: [{ heading: '극한', body: '본문' }], points: [] },
  keywords: [],
  bookmarks: [],
  pages: [],
  createdAt: '2026-11-22T00:00:00.000Z',
  updatedAt: '2026-11-22T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  useToast.setState({ msg: null } as never);
  mockApi.content.material.mockResolvedValue(note);
  mockApi.content.folders.mockResolvedValue([]);
  mockApi.content.friendShare.mockResolvedValue(share);
  mockApi.content.recording.mockResolvedValue({
    audioUrl: 'https://blob.example/a.m4a',
    durationSec: 60,
    slides: [],
    transcript: { text: '', segments: [] },
  });
});

const hook = async () => {
  // 앱처럼 기본 캐시 30초(src/lib/query.ts)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return (await renderHook(() => useOpenFriendShare(), { wrapper })).result;
};

describe('1:1 채팅 공유 카드 열기', () => {
  it('살아 있는 공유는 탭 밖 노트 보기를 공유 id 와 함께 연다(뒤로 가면 채팅, #674)', async () => {
    const open = await hook();
    await act(() => open.current('s1'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/note-view/hand/[id]',
      params: { id: 'n1', share: 's1' },
    });
  });

  it.each([
    [
      '철회 등으로 끝난 공유',
      () => mockApi.content.friendShare.mockResolvedValue({ ...share, active: false }),
    ],
    [
      '친구를 끊어 지워진 공유(404)',
      () =>
        mockApi.content.friendShare.mockRejectedValue(
          new MockApiError('NOT_FOUND', '공유 정보를 찾을 수 없어요', 404),
        ),
    ],
  ])('%s는 「공유가 끝났어요」', async (_name, arrange) => {
    arrange();
    const open = await hook();
    await act(() => open.current('s1'));
    expect(router.push).not.toHaveBeenCalled();
    expect(useToast.getState().msg).toBe('공유가 끝났어요');
  });

  it('한 번 연 뒤 끝난 공유는 캐시가 남아 있어도 다시 물어 「공유가 끝났어요」', async () => {
    const open = await hook();
    await act(() => open.current('s1'));
    expect(router.push).toHaveBeenCalledTimes(1);
    mockApi.content.friendShare.mockResolvedValue({ ...share, active: false });
    await act(() => open.current('s1'));
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(useToast.getState().msg).toBe('공유가 끝났어요');
  });

  it('보낸 사람은 끝난 공유도 자기 노트로 연다', async () => {
    mockApi.content.friendShare.mockResolvedValue({ ...share, mine: true, active: false });
    const open = await hook();
    await act(() => open.current('s1'));
    expect(router.push).toHaveBeenCalled();
  });
});

const FOLDER = {
  _id: 'f1',
  title: '생리학',
  subjectId: null,
  subjectName: '의학',
  materialCount: 2,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('스터디룸에서 연 남의 노트(?room=)', () => {
  it('편집 · 공유 · 퀴즈 · 선생님 없이 「내 폴더로 가져오기」만 둔다', async () => {
    setParams({ id: 'n1', room: 'r1' });
    mockApi.content.copyMaterial.mockResolvedValue({ _id: 'n2', folderId: 'f1' });
    mockApi.content.folders.mockResolvedValue([FOLDER]);
    await renderScreen(<HandDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: '내 폴더로 가져오기' }));
    expect(screen.queryByText('편집하기')).toBeNull();
    expect(screen.queryByText('공유하기')).toBeNull();
    expect(screen.queryByLabelText('파일 옵션')).toBeNull();
    await fireEvent.press(await screen.findByText('생리학'));
    await waitFor(() => expect(mockApi.content.copyMaterial).toHaveBeenCalledWith('n1', 'f1'));
  });
});

describe('공유 카드에서 연 노트', () => {
  it('받은 사람: 읽기 전용(편집 · 공유 · 더보기 없음)이고 「내 폴더로 가져오기」로 고른 폴더에 사본을 연다', async () => {
    setParams({ id: 'n1', share: 's1' });
    mockApi.content.copyMaterial.mockResolvedValue({ _id: 'n2', folderId: 'f1' });
    mockApi.content.folders.mockResolvedValue([FOLDER]);
    await renderScreen(<HandDetailScreen />);
    expect(await screen.findByText('민지님이 보낸 노트 · 읽기 전용')).toBeTruthy();
    expect(screen.queryByText('편집하기')).toBeNull();
    expect(screen.queryByText('공유하기')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: '내 폴더로 가져오기' }));
    await fireEvent.press(await screen.findByText('생리학'));
    await waitFor(() => expect(mockApi.content.copyMaterial).toHaveBeenCalledWith('n1', 'f1'));
    // 사본은 내 노트라 있던 노트 탭으로 돌아가 연다((tabs) 를 겹쳐 쌓지 않게, #674)
    expect(router.dismissTo).toHaveBeenCalledWith(
      { pathname: '/(tabs)/note/hand/[id]', params: { id: 'n2' } },
      { withAnchor: true },
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(useToast.getState().msg).toBe('내 폴더로 가져왔어요');
  });

  it('복사를 서버가 거절하면(정리 중 409) 그 문구', async () => {
    setParams({ id: 'n1', share: 's1' });
    mockApi.content.copyMaterial.mockRejectedValue(
      new MockApiError('NOTE_NOT_READY', '노트 정리가 끝난 뒤에 복사할 수 있어요', 409),
    );
    mockApi.content.folders.mockResolvedValue([FOLDER]);
    await renderScreen(<HandDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: '내 폴더로 가져오기' }));
    await fireEvent.press(await screen.findByText('생리학'));
    await waitFor(() =>
      expect(useToast.getState().msg).toBe('노트 정리가 끝난 뒤에 복사할 수 있어요'),
    );
  });

  it('보낸 사람: 「공유 끝내기」로 철회한다', async () => {
    setParams({ id: 'n1', share: 's1' });
    mockApi.content.friendShare.mockResolvedValue({ ...share, mine: true });
    mockApi.content.revokeFriendShare.mockResolvedValue(undefined);
    await renderScreen(<HandDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: '공유 끝내기' }));
    await waitFor(() => expect(mockApi.content.revokeFriendShare).toHaveBeenCalledWith('s1'));
    expect(useToast.getState().msg).toBe('공유를 끝냈어요');
  });

  it('끝난 공유면 버튼 없이 「공유가 끝났어요」', async () => {
    setParams({ id: 'n1', share: 's1' });
    mockApi.content.friendShare.mockResolvedValue({ ...share, mine: true, active: false });
    await renderScreen(<HandDetailScreen />);
    expect(await screen.findByText('공유가 끝났어요')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '공유 끝내기' })).toBeNull();
  });

  it('공유 카드가 아니면 예전처럼 편집 · 공유 버튼', async () => {
    setParams({ id: 'n1' });
    await renderScreen(<HandDetailScreen />);
    expect(await screen.findByText('편집하기')).toBeTruthy();
    expect(mockApi.content.friendShare).not.toHaveBeenCalled();
  });

  it('열어 둔 사이 친구를 끊어 공유가 404 면 「공유가 끝났어요」', async () => {
    setParams({ id: 'n1', share: 's1' });
    mockApi.content.friendShare.mockRejectedValue(
      new MockApiError('NOT_FOUND', '공유 정보를 찾을 수 없어요', 404),
    );
    await renderScreen(<HandDetailScreen />);
    expect(await screen.findByText('공유가 끝났어요')).toBeTruthy();
    expect(screen.queryByText('편집하기')).toBeNull();
  });

  // Codex 1차 리뷰: 화면을 연 동안 보낸 사람이 철회해도 다시 묻지 않아 계속 살아 있는 공유처럼 보였다
  it.each([
    ['철회', () => mockApi.content.friendShare.mockResolvedValue({ ...share, active: false })],
    [
      '친구 끊김(404)',
      () =>
        mockApi.content.friendShare.mockRejectedValue(
          new MockApiError('NOT_FOUND', '공유 정보를 찾을 수 없어요', 404),
        ),
    ],
  ])(
    '받은 사람이 열어 둔 사이 %s되면 30초 안에 「공유가 끝났어요」로 바뀐다',
    async (_n, arrange) => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      try {
        setParams({ id: 'n1', share: 's1' });
        await renderScreen(<HandDetailScreen />);
        expect(await screen.findByRole('button', { name: '내 폴더로 가져오기' })).toBeTruthy();
        arrange();
        await act(async () => jest.advanceTimersByTime(30_000));
        expect(await screen.findByText('공유가 끝났어요')).toBeTruthy();
        expect(screen.queryByRole('button', { name: '내 폴더로 가져오기' })).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('받은 녹음은 북마크를 더할 수 없다(주인 노트)', async () => {
    setParams({ id: 'n1', share: 's1' });
    mockApi.content.material.mockResolvedValue({
      ...note,
      kind: 'recording',
      source: 'live_recording',
    });
    mockApi.content.friendShare.mockResolvedValue({ ...share, kind: 'recording' });
    await renderScreen(<RecDetailScreen />);
    expect(await screen.findByRole('button', { name: '내 폴더로 가져오기' })).toBeTruthy();
    expect(screen.queryByLabelText('북마크 추가')).toBeNull();
  });
});
