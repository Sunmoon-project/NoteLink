import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { PickedScreen } from '../features/content/capture';
import { EditScreen } from '../features/content/detail';
import { Player } from '../features/content/player';
import { useDraft } from '../stores/draft';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  content: {
    checkImages: jest.fn(),
    material: jest.fn(),
    updateSummary: jest.fn(),
    recording: jest.fn(),
  },
};
const mockUpload = jest.fn();
const mockToast = jest.fn();
const mockPlayback = { currentTime: 42, duration: 200, playing: false, playbackRate: 1 };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/upload', () => ({
  checkFile: () => ({ ok: true }),
  uploadToBlob: (...args: unknown[]) => mockUpload(...args),
}));
jest.mock('../lib/image-edit', () => ({ editPhoto: jest.fn() }));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
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
  useAudioPlayerStatus: () => mockPlayback,
}));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return qc;
};
const firstPhoto = {
  uri: 'file:///a.jpg',
  name: 'same-name.jpg',
  size: 1200,
  mimeType: 'image/jpeg',
};
const secondPhoto = { ...firstPhoto, uri: 'file:///b.jpg' };
const material = (sections: { heading: string; body: string }[]) => ({
  _id: 'material-round4',
  folderId: 'folder1',
  title: '원문 보존 노트',
  kind: 'handwriting',
  createdAt: '2026-11-01T00:00:00Z',
  summary: { sections, points: [] },
  keywords: [],
  bookmarks: [],
});
beforeEach(() => {
  jest.clearAllMocks();
  useDraft.getState().reset();
  useDraft.getState().set({ files: [firstPhoto] });
  setParams({ id: 'material-round4' });
  mockUpload.mockImplementation(
    async (_kind: string, file: { uri: string }) =>
      `https://blob.example/${file.uri.includes('/a.') ? 'a' : 'b'}`,
  );
  mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
    files.map((file) => ({ name: file.name, verdict: 'ok' })),
  );
  mockApi.content.material.mockResolvedValue(material([]));
  mockApi.content.updateSummary.mockResolvedValue(material([]));
  mockPlayback.currentTime = 42;
});
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

describe('PR36 서버 사진 판정과 식별', () => {
  it('기기 형식 검사를 통과해도 서버 not_allowed 판정이면 변환을 차단한다', async () => {
    mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
      files.map((file) => ({ name: file.name, verdict: 'not_allowed' })),
    );
    await renderScreen(<PickedScreen />, client());
    await screen.findByText('올릴 수 없는 파일');
    expect(screen.getByRole('button', { name: '다음' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
  });
  it('이름이 같아도 URI가 다른 사진을 구별해 통과한 한 장만 남긴다', async () => {
    useDraft.getState().set({ files: [firstPhoto, secondPhoto] });
    mockApi.content.checkImages.mockImplementation(async (files: { name: string; uri: string }[]) =>
      files.map((file) => ({
        name: file.name,
        verdict: file.uri.endsWith('/a') ? 'ok' : 'not_handwriting',
      })),
    );
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(await screen.findByText('필기 사진 1장만 올리기'));
    await waitFor(() => expect(useDraft.getState().files).toEqual([firstPhoto]));
  });
});

describe('PR36 편집 원문 보존', () => {
  it.each([
    { name: '빈 제목의 본문', sections: [{ heading: '', body: '제목 없이 보존해야 할 본문' }] },
    {
      name: '본문 줄바꿈과 빈 문단',
      sections: [
        { heading: '제목', body: '첫째 줄\n둘째 줄\n\n셋째 문단' },
        { heading: '다음 절', body: '끝\n마지막' },
      ],
    },
  ])('$name을 수정 없이 저장하면 구조와 문자열을 그대로 보존한다', async ({ sections }) => {
    mockApi.content.material.mockResolvedValue(material(sections));
    await renderScreen(<EditScreen />, client());
    await waitFor(() =>
      expect(screen.getByLabelText('노트 내용').props.value).toContain(sections[0]!.body),
    );
    await fireEvent.press(screen.getAllByText('저장')[0]!);
    await waitFor(() =>
      expect(mockApi.content.updateSummary).toHaveBeenCalledWith('material-round4', sections),
    );
  });
});

describe('PR36 녹음 대본 시간 구간', () => {
  it.each([
    { time: 42, active: 2 },
    { time: 20, active: -1 },
  ])('$time초에는 실제 시작·종료 구간만 강조한다', async ({ time, active }) => {
    mockPlayback.currentTime = time;
    const segments = [
      { startSec: 0, endSec: 2, text: '처음 짧은 구간' },
      { startSec: 3, endSec: 5, text: '두 번째 짧은 구간' },
      { startSec: 40, endSec: 50, text: '현재 긴 구간' },
    ];
    mockApi.content.recording.mockResolvedValue({
      audioUrl: 'https://blob.example/audio.m4a',
      durationSec: 200,
      slides: [],
      transcript: { text: '', segments },
    });
    await renderScreen(<Player materialId="material-round4" />, client());
    await screen.findByText('현재 긴 구간');
    for (const [index, segment] of segments.entries()) {
      const emphasized = String(screen.getByText(segment.text).props.className ?? '').includes(
        'font-bold',
      );
      expect(emphasized).toBe(index === active);
    }
    await act(async () => {});
  });
});
