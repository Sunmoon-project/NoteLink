import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { ResultScreen } from '../features/content/convert';
import { ApiError } from '../lib/api/http';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

// 실기기 피드백(2026-11-20): 변환 결과가 마음에 들지 않으면 같은 원본으로 다시 만들고 싶다
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  useLocalSearchParams: () => globalThis.mockParams,
  useSegments: () => [],
}));
const mockApi = {
  ai: { job: jest.fn() },
  content: {
    material: jest.fn(),
    saveMaterial: jest.fn(),
    regenerate: jest.fn(),
    recording: jest.fn(),
  },
};
jest.mock('../lib/api', () => ({
  NetworkError: class NetworkError extends Error {},
  get ApiError() {
    return jest.requireActual('../lib/api/http').ApiError;
  },
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'https://api.example' } }));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
// 녹음 결과 화면의 플레이어(재생 · 3D 아바타)는 화면 확인에 필요 없어 가짜로 둔다
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({
    loop: false,
    play: jest.fn(),
    pause: jest.fn(),
    seekTo: jest.fn(),
    setPlaybackRate: jest.fn(),
  }),
  useAudioPlayerStatus: () => ({ currentTime: 0, duration: 200, playing: false, playbackRate: 1 }),
}));
jest.mock('../features/tutor/avatar3d', () => ({ Avatar3D: () => null }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const note = (heading: string, summaryFormat?: string) => ({
  _id: 'm1',
  ...(summaryFormat ? { summaryFormat } : {}),
  folderId: 'f1',
  title: '미적분 필기',
  kind: 'handwriting',
  keywords: [],
  bookmarks: [],
  summary: { sections: [{ heading, body: '본문' }], points: [] },
  pages: [],
  processing: { status: 'done', progress: 100, jobId: 'j1' },
});
const job = (status: string) => ({ _id: 'j2', status, targetId: 'm1', progress: 0, attempts: 0 });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  jest.clearAllMocks();
  useToast.setState({ msg: null });
  setParams({ id: 'm1' });
  mockApi.content.material.mockResolvedValue(note('미분'));
  mockApi.content.regenerate.mockResolvedValue({ material: note('미분'), job: job('queued') });
});

// 다시 만들기는 양식 고르기 시트로 묻는다(FR-19). 지금 양식은 고를 수 없다
const askAndConfirm = async (pick = '문답') => {
  await fireEvent.press(await screen.findByRole('button', { name: '다시 만들기' }));
  expect(screen.getByText('어떤 모습으로 정리할까요?')).toBeTruthy();
  expect(screen.getByText(/지금 결과는 사라져요/)).toBeTruthy();
  expect(screen.getByRole('radio', { name: '핵심 요약' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('radio', { name: pick }));
  await fireEvent.press(screen.getByRole('button', { name: '이 모습으로 만들기' }));
};

it('결과 화면은 「학습자료에 저장」 아래 「다시 만들기」를 두고, 시트를 닫으면 보내지 않는다', async () => {
  await renderScreen(<ResultScreen />, client());
  expect(await screen.findByRole('button', { name: '학습자료에 저장' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '다시 만들기' }));
  await fireEvent.press(screen.getAllByLabelText('닫기')[0]!);
  expect(mockApi.content.regenerate).not.toHaveBeenCalled();
});

it('지금 양식이 문답이면 문답을 고를 수 없고 핵심 요약은 고를 수 있다', async () => {
  mockApi.content.material.mockResolvedValue(note('미분', 'qa'));
  await renderScreen(<ResultScreen />, client());
  await fireEvent.press(await screen.findByRole('button', { name: '다시 만들기' }));
  expect(screen.getByRole('radio', { name: '문답' })).toBeDisabled();
  expect(screen.getByText('문답 · 지금 양식')).toBeTruthy();
  await fireEvent.press(screen.getByRole('radio', { name: '핵심 요약' }));
  await fireEvent.press(screen.getByRole('button', { name: '이 모습으로 만들기' }));
  await waitFor(() => expect(mockApi.content.regenerate).toHaveBeenCalledWith('m1', 'points'));
});

it('고른 양식으로 하나도 못 만들면(노트 양식 그대로) 그 양식을 만들 수 없다고 알린다', async () => {
  jest.useFakeTimers();
  try {
    mockApi.ai.job.mockResolvedValue(job('succeeded'));
    await renderScreen(<ResultScreen />, client());
    await askAndConfirm('용어 정리');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() =>
      expect(useToast.getState().msg).toBe(
        '이 노트에서는 용어 정리 양식을 만들 수 없어요. 지금 결과는 그대로예요',
      ),
    );
  } finally {
    jest.useRealTimers();
  }
});

it('녹음 결과에는 「다시 만들기」가 없다', async () => {
  mockApi.content.material.mockResolvedValue({
    ...note('강의'),
    title: '강의 녹음',
    kind: 'recording',
  });
  mockApi.content.recording.mockResolvedValue({
    _id: 'm1',
    materialId: 'm1',
    audioUrl: 'https://blob.example/audio.m4a',
    durationSec: 200,
    slides: [{ index: 0, title: '슬라이드', bullets: [], startSec: 0, endSec: 200 }],
    transcript: { text: '대본', segments: [] },
  });
  await renderScreen(<ResultScreen />, client());
  expect(await screen.findByRole('button', { name: '학습자료에 저장' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '다시 만들기' })).toBeNull();
});

it('확인하면 다시 만들고, 새 결과가 나오면 바꿔 보여 준다', async () => {
  jest.useFakeTimers();
  try {
    mockApi.ai.job.mockResolvedValue(job('running'));
    await renderScreen(<ResultScreen />, client());
    await askAndConfirm();
    await waitFor(() => expect(mockApi.content.regenerate).toHaveBeenCalledWith('m1', 'qa'));
    expect(await screen.findByText(/새 결과가 나오면 바로 바꿔/)).toBeTruthy();
    // 기다리는 동안 지금 결과는 그대로
    expect(screen.getByText('미분')).toBeTruthy();
    mockApi.ai.job.mockResolvedValue(job('succeeded'));
    mockApi.content.material.mockResolvedValue(note('적분', 'qa'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1600);
    });
    expect(await screen.findByText('적분')).toBeTruthy();
    expect(mockApi.ai.job).toHaveBeenCalledWith('j2');
    expect(useToast.getState().msg).toBe('결과를 새로 만들었어요');
  } finally {
    jest.useRealTimers();
  }
});

it('새 작업이 실패하면 지금 결과를 그대로 두고 알린다', async () => {
  jest.useFakeTimers();
  try {
    mockApi.ai.job.mockResolvedValue(job('failed'));
    await renderScreen(<ResultScreen />, client());
    await askAndConfirm();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1600);
    });
    await waitFor(() =>
      expect(useToast.getState().msg).toBe('다시 만들지 못했어요. 지금 결과는 그대로예요'),
    );
    expect(screen.getByText('미분')).toBeTruthy();
  } finally {
    jest.useRealTimers();
  }
});

it('하루 한도를 넘으면 서버 문구를 그대로 보인다', async () => {
  mockApi.content.regenerate.mockRejectedValue(
    new ApiError('RATE_LIMITED', '오늘은 다시 만들기를 3번 다 썼어요. 내일 다시 해 주세요', 429),
  );
  await renderScreen(<ResultScreen />, client());
  await askAndConfirm();
  await waitFor(() =>
    expect(useToast.getState().msg).toBe('오늘은 다시 만들기를 3번 다 썼어요. 내일 다시 해 주세요'),
  );
  expect(mockApi.ai.job).not.toHaveBeenCalled();
});
