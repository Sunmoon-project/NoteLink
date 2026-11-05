import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { DocDetailScreen, HandDetailScreen, RecDetailScreen } from '../features/content/detail';
import { ApiError } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

const mockApi = { content: { material: jest.fn(), recording: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {
    constructor(code: string, message: string, status: number) {
      super(message);
      Object.assign(this, { code, status });
    }
  },
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
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
  useAudioPlayerStatus: () => ({ currentTime: 0, duration: 180, playing: false, playbackRate: 1 }),
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
const material = (kind: 'handwriting' | 'document' | 'recording') => ({
  _id: `material-${kind}`,
  folderId: 'folder1',
  kind,
  title: '다시 조회한 실제 자료',
  createdAt: '2026-11-01T00:00:00Z',
  summary: {
    sections: [{ heading: '복구한 제목', body: '복구한 본문' }],
    points: ['복구한 핵심 요약'],
  },
  keywords: [],
  bookmarks: [],
});
const cases = [
  { name: '필기', kind: 'handwriting', Detail: HandDetailScreen },
  { name: '문서', kind: 'document', Detail: DocDetailScreen },
  { name: '녹음', kind: 'recording', Detail: RecDetailScreen },
] as const;
const errorMessage = /불러오지 못|조회.*실패|자료.*없|찾을 수 없|삭제된 자료/;
beforeEach(() => {
  jest.clearAllMocks();
  mockApi.content.material.mockReset();
  mockApi.content.recording.mockResolvedValue({
    audioUrl: 'https://blob.example/audio.m4a',
    durationSec: 180,
    slides: [],
    transcript: { text: '', segments: [] },
  });
});
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

it.each(cases)(
  '$name 상세의 최초 조회 실패는 오류와 재시도를 표시하고 같은 ID로 복구한다',
  async ({ kind, Detail }) => {
    const saved = material(kind);
    setParams({ id: saved._id });
    mockApi.content.material.mockRejectedValueOnce(new Error('연결 실패')).mockResolvedValue(saved);
    await renderScreen(<Detail />, client());
    await waitFor(() => expect(screen.queryAllByText(errorMessage).length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('파일 옵션')).toBeNull();
    expect(mockApi.content.material).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }));
    await screen.findByLabelText('파일 옵션');
    expect(mockApi.content.material).toHaveBeenCalledTimes(2);
    expect(mockApi.content.material).toHaveBeenNthCalledWith(2, saved._id);
    expect(screen.queryAllByText(errorMessage)).toHaveLength(0);
    if (kind !== 'recording') expect(screen.getByText(saved.title)).toBeTruthy();
    else await waitFor(() => expect(mockApi.content.recording).toHaveBeenCalledWith(saved._id));
    expect(router.back).not.toHaveBeenCalled();
  },
);

it.each(cases)(
  '$name 상세의 삭제된 자료 ID는 무한 로딩 대신 안내와 복귀 경로를 제공한다',
  async ({ kind, Detail }) => {
    const id = `deleted-${kind}`;
    setParams({ id });
    mockApi.content.material.mockRejectedValue(
      new ApiError('NOT_FOUND', '이미 삭제된 자료입니다', 404),
    );
    await renderScreen(<Detail />, client());
    await waitFor(() => expect(screen.queryAllByText(errorMessage).length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('파일 옵션')).toBeNull();
    expect(mockApi.content.material).toHaveBeenCalledWith(id);
    const back =
      screen.queryByRole('button', { name: /뒤로|돌아가기|목록/ }) ?? screen.getByLabelText('뒤로');
    await fireEvent.press(back);
    expect(router.back).toHaveBeenCalledTimes(1);
  },
);
