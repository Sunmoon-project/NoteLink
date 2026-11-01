import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { PhotoCheckScreen, PickedScreen } from '../features/content/capture';
import { DocDetailScreen, HandDetailScreen } from '../features/content/detail';
import { Player } from '../features/content/player';
import { useDraft } from '../stores/draft';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  content: {
    checkImages: jest.fn(),
    material: jest.fn(),
    downloadUrl: jest.fn(),
    recording: jest.fn(),
    addBookmark: jest.fn(),
  },
};
const mockUpload = jest.fn();
const mockEdit = jest.fn();
const mockToast = jest.fn();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/upload', () => ({
  checkFile: () => ({ ok: true }),
  uploadToBlob: (...args: unknown[]) => mockUpload(...args),
}));
jest.mock('../lib/image-edit', () => ({ editPhoto: (...args: unknown[]) => mockEdit(...args) }));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
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
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

const localPhoto = {
  uri: 'file:///picked.jpg',
  name: 'picked.jpg',
  size: 1200,
  mimeType: 'image/jpeg',
};
const editedPhoto = {
  uri: 'file:///edited.jpg',
  name: 'edited.jpg',
  size: 900,
  mimeType: 'image/jpeg',
};
const blobUrl = 'https://blob.example/checked-photo.jpg';
const sourceUrl = 'https://blob.example/original-upload.pdf';
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return qc;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  jest.clearAllMocks();
  useDraft.getState().reset();
  useDraft.getState().set({ kind: 'handwriting', files: [localPhoto], folderId: 'folder1' });
  setParams({ id: 'material1' });
  mockUpload.mockResolvedValue(blobUrl);
  mockEdit.mockResolvedValue(editedPhoto);
  mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
    files.map((file) => ({ name: file.name, verdict: 'ok' })),
  );
  mockApi.content.downloadUrl.mockResolvedValue({ url: sourceUrl, fileName: '원본.pdf' });
  mockApi.content.material.mockResolvedValue({
    _id: 'material1',
    folderId: 'folder1',
    title: '실제 업로드 자료',
    kind: 'handwriting',
    createdAt: '2026-11-01T00:00:00Z',
    keywords: [],
    bookmarks: [],
    summary: { sections: [], points: [] },
    pages: [
      {
        _id: 'page1',
        pageNo: 1,
        imageUrl: 'https://blob.example/real-page.jpg',
        ocrText: null,
        takenAt: null,
      },
    ],
  });
  mockApi.content.recording.mockResolvedValue({
    audioUrl: 'https://blob.example/audio.m4a',
    durationSec: 180,
    slides: [],
    transcript: { text: '', segments: [] },
  });
  mockApi.content.addBookmark.mockResolvedValue(undefined);
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.restoreAllMocks();
});

describe('PR36 사진 검사 경계', () => {
  it('사진 내용을 서버가 읽을 수 있도록 Blob URL로 검사한 뒤에만 진행한다', async () => {
    await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalled());
    expect(mockUpload.mock.calls[0]?.slice(0, 2)).toEqual(['image', localPhoto]);
    expect(mockApi.content.checkImages).toHaveBeenCalledWith([
      { name: `0-${localPhoto.name}`, sizeBytes: localPhoto.size, uri: blobUrl },
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    expect(router.replace).toHaveBeenCalledWith('/convert');
  });
  it.each(['request-error', 'missing-verdict'] as const)(
    '검사 %s이면 다음을 막고 재검사 성공 후 복구한다',
    async (mode) => {
      if (mode === 'request-error')
        mockApi.content.checkImages.mockRejectedValueOnce(new Error('검사 서버 실패'));
      else mockApi.content.checkImages.mockResolvedValueOnce([]);
      await renderScreen(<PickedScreen />, client());
      await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(screen.getByRole('button', { name: '다음' })).toBeDisabled();
      await fireEvent.press(await screen.findByText('다시 검사'));
      await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    },
  );
  it('Blob 업로드가 실패하면 검사 요청이나 변환 이동 없이 다시 검사할 수 있다', async () => {
    mockUpload.mockRejectedValueOnce(new Error('업로드 실패'));
    await renderScreen(<PickedScreen />, client());
    expect(await screen.findByText('다시 검사')).toBeTruthy();
    expect(mockApi.content.checkImages).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '다음' })).toBeDisabled();
    expect(router.replace).not.toHaveBeenCalledWith('/convert');
  });
  it('보정한 실제 파일을 draft와 다음 검사 업로드에 반영한다', async () => {
    const rendered = await renderScreen(<PhotoCheckScreen />, client());
    await fireEvent.press(screen.getByText('회전'));
    await fireEvent.press(screen.getByText('자르기'));
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    await waitFor(() => expect(useDraft.getState().files[0]).toEqual(editedPhoto));
    expect(mockEdit).toHaveBeenCalledWith(localPhoto, 90, true);
    await rendered.unmount();
    await renderScreen(<PickedScreen />, client());
    await waitFor(() =>
      expect(mockUpload.mock.calls[0]?.slice(0, 2)).toEqual(['image', editedPhoto]),
    );
    expect(mockApi.content.checkImages).toHaveBeenCalledWith([
      { name: `0-${editedPhoto.name}`, sizeBytes: editedPhoto.size, uri: blobUrl },
    ]);
  });
});

describe('PR36 실제 원본 및 북마크', () => {
  it.each([
    { Screen: HandDetailScreen, tab: '원본 이미지' },
    { Screen: DocDetailScreen, tab: '원본 문서' },
  ])('$tab에서 저장된 실제 원본 URL을 연다', async ({ Screen, tab }) => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    setParams({ id: 'material1', tab });
    await renderScreen(<Screen />, client());
    await fireEvent.press(await screen.findByText('원본 파일 열기'));
    await waitFor(() => expect(mockApi.content.downloadUrl).toHaveBeenCalledWith('material1'));
    expect(open).toHaveBeenCalledWith(sourceUrl);
  });
  it('북마크 저장 실패는 목록과 성공 안내에 반영하지 않고 재시도를 허용한다', async () => {
    mockApi.content.addBookmark.mockRejectedValueOnce(new Error('저장 거절'));
    await renderScreen(<Player materialId="material1" />, client());
    await screen.findByText('북마크 모음 (0)');
    await fireEvent.press(screen.getByLabelText('북마크 추가'));
    await waitFor(() => expect(mockApi.content.addBookmark).toHaveBeenCalledWith('material1', 42));
    await act(async () => {});
    expect(screen.getByText('북마크 모음 (0)')).toBeTruthy();
    expect(mockToast.mock.calls.some(([text]) => String(text).includes('북마크했어요'))).toBe(
      false,
    );
    expect(mockToast).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('북마크 추가'));
    await screen.findByText('북마크 모음 (1)');
    expect(mockApi.content.addBookmark).toHaveBeenCalledTimes(2);
  });
  it('북마크는 저장 응답을 기다리는 동안 완료를 안내하지 않는다', async () => {
    const pending = deferred<void>();
    mockApi.content.addBookmark.mockReturnValueOnce(pending.promise);
    await renderScreen(<Player materialId="material1" />, client());
    await screen.findByText('북마크 모음 (0)');
    // 실제 누르기와 같은 순서로 시작하고 네트워크 응답은 나중에 완료한다.
    const user = userEvent.setup();
    await user.press(screen.getByLabelText('북마크 추가'));
    await waitFor(() => expect(mockApi.content.addBookmark).toHaveBeenCalledTimes(1));
    expect(mockToast.mock.calls.some(([text]) => String(text).includes('북마크했어요'))).toBe(
      false,
    );
    await act(async () => pending.resolve());
    await screen.findByText('북마크 모음 (1)');
  });
});
