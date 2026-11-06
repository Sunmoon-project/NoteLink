import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { ShareScreen } from '../features/content/detail';
import { Player } from '../features/content/player';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  content: {
    material: jest.fn(),
    materials: jest.fn(),
    folders: jest.fn(),
    share: jest.fn(),
    recording: jest.fn(),
    addBookmark: jest.fn(),
  },
  rooms: { mine: jest.fn() },
  social: { friends: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-audio', () => ({
  AudioModule: {},
  RecordingPresets: {},
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
  useAudioRecorderState: jest.fn(),
  useAudioPlayer: () => ({
    loop: false,
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    setPlaybackRate: jest.fn(),
  }),
  useAudioPlayerStatus: () => ({ currentTime: 42, duration: 180, playing: false, playbackRate: 1 }),
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30000, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
};
const material = (id: string, kind: 'document' | 'recording' | 'handwriting', title: string) => ({
  _id: id,
  folderId: 'shared-folder',
  kind,
  title,
  createdAt: '2026-11-01T00:00:00Z',
  keywords: [],
  bookmarks: [] as { atSec: number }[],
  summary: { sections: [], points: [] },
});
beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
  mockApi.content.folders.mockResolvedValue([{ _id: 'shared-folder' }]);
  mockApi.content.share.mockResolvedValue(undefined);
  mockApi.rooms.mine.mockResolvedValue([{ _id: 'actual-target', title: '실제 공유 대상' }]);
  mockApi.social.friends.mockResolvedValue([]);
  mockApi.content.recording.mockResolvedValue({
    audioUrl: 'https://blob.example/audio.m4a',
    durationSec: 180,
    slides: [],
    transcript: { text: '', segments: [] },
  });
  mockApi.content.addBookmark.mockResolvedValue(undefined);
});
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

it.each([
  { kind: 'document', title: '선택한 실제 문서.pdf' },
  { kind: 'recording', title: '선택한 실제 녹음.m4a' },
  { kind: 'handwriting', title: '선택한 실제 필기.jpg' },
] as const)(
  '$kind 상세에서 공유하면 실제 자료가 선택된 종류 탭에 보이고 그 ID만 전송한다',
  async ({ kind, title }) => {
    const id = `selected-${kind}`;
    const selected = material(id, kind, title);
    mockApi.content.material.mockResolvedValue(selected);
    mockApi.content.materials.mockResolvedValue([
      selected,
      material('unselected-note', 'handwriting', '고르지 않은 다른 필기'),
    ]);
    setParams({ id });
    await renderScreen(<ShareScreen />, client());
    await screen.findByText(title);
    expect(screen.queryByText('공유할 필기 자료가 없어요')).toBeNull();
    if (kind !== 'handwriting') expect(screen.queryByText('고르지 않은 다른 필기')).toBeNull();
    await fireEvent.press(screen.getByText(/공유 대상을 선택해주세요/));
    await fireEvent.press(await screen.findByText('실제 공유 대상'));
    const share = screen.getByRole('button', { name: '공유하기' });
    expect(share).not.toBeDisabled();
    // 화면에 보이는 진입 자료의 체크 상태와 실제 전송 선택이 같은지 확인한다.
    await fireEvent.press(screen.getByText(title));
    expect(screen.getByRole('button', { name: '공유하기' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: '공유하기' }));
    expect(mockApi.content.share).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText(title));
    await fireEvent.press(screen.getByRole('button', { name: '공유하기' }));
    await waitFor(() =>
      expect(mockApi.content.share).toHaveBeenCalledWith({
        materialIds: [id],
        target: { type: 'room', id: 'actual-target' },
      }),
    );
  },
);

it('북마크 저장 후 30초 캐시 유효 시간 안에 재진입해도 저장한 북마크가 남는다', async () => {
  const id = 'recording-bookmark-cache';
  const saved: number[] = [];
  mockApi.content.material.mockImplementation(async () => ({
    ...material(id, 'recording', '실제 녹음'),
    bookmarks: saved.map((atSec) => ({ atSec })),
  }));
  mockApi.content.addBookmark.mockImplementation(async (_materialId: string, atSec: number) => {
    saved.push(atSec);
  });
  const qc = client();
  const first = await renderScreen(<Player materialId={id} />, qc);
  await screen.findByText('북마크 모음 (0)');
  await fireEvent.press(screen.getByLabelText('북마크 추가'));
  await screen.findByText('북마크 모음 (1)');
  expect(saved).toEqual([42]);
  await first.unmount();
  await renderScreen(<Player materialId={id} />, qc);
  await fireEvent.press(await screen.findByText('북마크 모음 (1)'));
  expect(await screen.findByText('00:00:42')).toBeTruthy();
  expect(
    qc.getQueryData<{ bookmarks: { atSec: number }[] }>(['material', id])?.bookmarks,
  ).toContainEqual({ atSec: 42 });
});
