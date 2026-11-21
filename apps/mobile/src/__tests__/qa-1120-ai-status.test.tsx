import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { DocDetailScreen, HandDetailScreen } from '../features/content/detail';
import { Player } from '../features/content/player';
import { aiStateOf } from '../lib/ai';
import { useRetrying } from '../stores/retrying';
import { renderScreen, setParams } from '../test-utils';

// develop 점검(2026-11-20) #3 · #4: 요약 · 음성 인식에 실패한 자료도 「AI 서버를 기다리고 있어요」로 보였다.
// 상세 · 플레이어가 처리 상태(processing.status)를 보지 않고 결과가 비면 늘 서버 대기 안내를 띄웠다
const mockEnv = { localData: false, apiUrl: 'https://api.example' };
jest.mock('../lib/env', () => ({
  get env() {
    return mockEnv;
  },
}));
const mockApi = {
  content: { material: jest.fn(), folders: jest.fn(), recording: jest.fn() },
  ai: { retry: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
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
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

type Status = 'uploading' | 'queued' | 'processing' | 'done' | 'failed';
const material = (kind: string, status: Status) => ({
  _id: 'm1',
  folderId: 'f1',
  kind,
  title: '운영체제 3장',
  description: null,
  createdAt: '2026-11-01T00:00:00Z',
  processing: { status, progress: 0, jobId: 'job-1' },
  summary: null,
  keywords: [],
  bookmarks: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockEnv.localData = false;
  setParams({ id: 'm1' });
  mockApi.content.folders.mockResolvedValue([]);
  mockApi.content.recording.mockResolvedValue({
    audioUrl: 'https://blob.example/a.m4a',
    durationSec: 60,
    slides: [],
    transcript: { text: '', segments: [] },
  });
  useRetrying.getState().reset();
});

describe('aiStateOf — 결과가 빈 자료가 지금 어떤 상태인지 한 곳에서 판단', () => {
  it.each([
    ['failed', false, 'failed'],
    ['failed', true, 'failed'],
    ['done', false, 'done'],
    ['queued', false, 'working'],
    ['processing', false, 'working'],
    ['uploading', false, 'working'],
    ['queued', true, 'waiting'],
    ['processing', true, 'waiting'],
  ] as const)('%s · 기기 저장 %s → %s', (status, local, want) => {
    mockEnv.localData = local;
    expect(aiStateOf({ status })).toBe(want);
  });
  it('처리 정보가 없으면(등록 직후) 처리 중으로 본다', () => {
    expect(aiStateOf(undefined)).toBe('working');
  });
});

describe('#3 노트 상세', () => {
  it('요약에 실패한 문서는 「요약하지 못했어요」와 다시 요약을 보이고, 서버 대기라고 하지 않는다', async () => {
    mockApi.content.material.mockResolvedValue(material('document', 'failed'));
    await renderScreen(<DocDetailScreen />);
    expect(await screen.findByText('요약하지 못했어요')).toBeTruthy();
    expect(screen.queryByText(/AI 서버를 기다리고 있어요/)).toBeNull();
    expect(screen.getByRole('button', { name: '다시 요약' })).toBeTruthy();
  });

  it('다시 요약은 폴더 목록과 같은 재시도(api.ai.retry)를 부르고 정리 중으로 바뀐다', async () => {
    mockApi.content.material.mockResolvedValue(material('document', 'failed'));
    mockApi.ai.retry.mockResolvedValue({ _id: 'job-2' });
    await renderScreen(<DocDetailScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: '다시 요약' }));
    await waitFor(() => expect(mockApi.ai.retry).toHaveBeenCalledWith('job-1'));
    // 폴더 목록도 끝날 때까지 이 자료를 따로 읽는다(목록에 「요약 실패」가 남지 않게)
    expect(useRetrying.getState().byFolder.f1).toEqual(['m1']);
    expect(await screen.findByText('문서 요약을 만들고 있어요')).toBeTruthy();
  });

  it('서버 모드에서 처리 중이면 진행 안내를 보이고 서버 연결 문구는 없다', async () => {
    mockApi.content.material.mockResolvedValue(material('document', 'processing'));
    await renderScreen(<DocDetailScreen />);
    expect(await screen.findByText('문서 요약을 만들고 있어요')).toBeTruthy();
    expect(screen.queryByText(/서버가 연결되면/)).toBeNull();
  });

  it('기기 저장 모드에서만 「서버가 연결되면」 안내를 보인다', async () => {
    mockEnv.localData = true;
    mockApi.content.material.mockResolvedValue(material('document', 'queued'));
    await renderScreen(<DocDetailScreen />);
    expect(await screen.findByText('문서 요약은 AI 서버를 기다리고 있어요')).toBeTruthy();
  });

  it('필기도 정리에 실패하면 「정리하지 못했어요」와 다시 정리', async () => {
    mockApi.content.material.mockResolvedValue(material('handwriting', 'failed'));
    await renderScreen(<HandDetailScreen />);
    expect(await screen.findByText('정리하지 못했어요')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 정리' })).toBeTruthy();
  });
});

describe('#4 녹음 플레이어 대본 없음', () => {
  it.each([
    ['failed', false, '대본을 만들지 못했어요. 원본 녹음은 지금 들을 수 있어요.'],
    ['processing', false, '대본을 만들고 있어요. 원본 녹음은 지금 들을 수 있어요.'],
    ['done', false, '녹음에서 말한 내용을 찾지 못했어요.'],
    [
      'queued',
      true,
      '대본은 AI 서버가 연결되면 음성 인식으로 만들어져요. 원본 녹음은 지금 들을 수 있어요.',
    ],
  ] as const)('%s · 기기 저장 %s → 「%s」', async (status, local, text) => {
    mockEnv.localData = local;
    mockApi.content.material.mockResolvedValue(material('recording', status));
    await renderScreen(<Player materialId="m1" />);
    expect(await screen.findByText(text)).toBeTruthy();
  });
});
