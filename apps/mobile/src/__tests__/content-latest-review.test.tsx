import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { PhotoCheckScreen, PickedScreen } from '../features/content/capture';
import { DocDetailScreen, HandDetailScreen, RecDetailScreen } from '../features/content/detail';
import { Player } from '../features/content/player';
import { ConvertScreen, ResultScreen } from '../features/content/convert';
import { NetworkError } from '../lib/api';
import { useDraft } from '../stores/draft';
import { renderScreen, setParams } from '../test-utils';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  useLocalSearchParams: () => globalThis.mockParams,
  useSegments: () => [],
}));

const mockApi = {
  content: {
    checkImages: jest.fn(),
    material: jest.fn(),
    downloadUrl: jest.fn(),
    recording: jest.fn(),
    addBookmark: jest.fn(),
    saveMaterial: jest.fn(),
    createMaterial: jest.fn(),
  },
};
const mockUpload = jest.fn();
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
const mockEdit = jest.fn();
const mockToast = jest.fn();
jest.mock('../lib/api', () => ({
  NetworkError: class NetworkError extends Error {},
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
  mockApi.content.createMaterial.mockResolvedValue({
    material: { _id: 'created' },
    job: { _id: 'job1', status: 'running', progress: 0 },
  });
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

describe('PR36 녹음·변환 결과 조회 복구', () => {
  it.each(['recording', 'material'] as const)(
    '%s 조회 실패 후 재시도하면 재생 화면을 복구한다',
    async (endpoint) => {
      mockApi.content[endpoint].mockRejectedValueOnce(new Error('조회 실패'));
      await renderScreen(<Player materialId="material1" />, client());
      expect(await screen.findByText('재생 자료를 불러오지 못했어요')).toBeTruthy();
      expect(screen.queryByLabelText('북마크 추가')).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }));
      await screen.findByText('북마크 모음 (0)');
      expect(mockApi.content[endpoint]).toHaveBeenCalledTimes(2);
    },
  );
  it('변환 결과 조회 실패를 재시도한 뒤 같은 자료를 저장한다', async () => {
    mockApi.content.material.mockRejectedValueOnce(new Error('결과 조회 실패'));
    mockApi.content.saveMaterial.mockResolvedValue(undefined);
    await renderScreen(<ResultScreen />, client());
    expect(await screen.findByText('변환 결과를 불러오지 못했어요')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '학습자료에 저장' })).toBeNull();
    expect(mockApi.content.saveMaterial).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: '다시 시도' }));
    await fireEvent.press(await screen.findByRole('button', { name: '학습자료에 저장' }));
    await waitFor(() => expect(mockApi.content.saveMaterial).toHaveBeenCalledWith('material1'));
    await waitFor(() =>
      expect(router.dismissTo).toHaveBeenCalledWith({
        pathname: '/(tabs)/note/folder/[id]',
        params: { id: 'folder1' },
      }),
    );
  });
  it('결과 조회 실패 화면에서 뒤로 이동할 수 있다', async () => {
    mockApi.content.material.mockRejectedValueOnce(new Error('결과 조회 실패'));
    await renderScreen(<ResultScreen />, client());
    await fireEvent.press(await screen.findByRole('button', { name: '뒤로' }));
    expect(router.back).toHaveBeenCalled();
  });
});

describe('PR36 검사 Blob 재사용', () => {
  it('검사한 파일별 URL을 변환에서 재사용해 중복 업로드하지 않는다', async () => {
    const second = { ...localPhoto, uri: 'file:///second.jpg', name: 'second.jpg' };
    useDraft.getState().set({ files: [localPhoto, second] });
    mockUpload.mockImplementation(
      async (_kind: string, file: { name: string }) => `https://blob.example/${file.name}`,
    );
    const picked = await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    await picked.unmount();
    await renderScreen(<ConvertScreen />, client());
    await waitFor(() =>
      expect(mockApi.content.createMaterial).toHaveBeenCalledWith(
        expect.objectContaining({
          blobUrls: ['https://blob.example/picked.jpg', 'https://blob.example/second.jpg'],
        }),
      ),
    );
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });
  it('검사 API 실패 뒤 재검사에서도 업로드한 URL을 재사용한다', async () => {
    mockApi.content.checkImages.mockRejectedValueOnce(new Error('검사 실패'));
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(await screen.findByText('다시 검사'));
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.content.checkImages).toHaveBeenCalledTimes(2);
  });
  it('사진 추가는 기존 URL을 유지하고 같은 URI의 교체 파일은 새로 업로드한다', async () => {
    await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    const second = { ...localPhoto, uri: 'file:///second.jpg', name: 'second.jpg' };
    await act(async () => useDraft.getState().set({ files: [localPhoto, second] }));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    expect(mockUpload).toHaveBeenCalledTimes(2);
    await act(async () => useDraft.getState().set({ files: [{ ...localPhoto }, second] }));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(3));
    expect(mockUpload).toHaveBeenCalledTimes(3);
  });
  it('제거·초기화한 사진과 뒤늦은 업로드 응답은 초안에 남기지 않는다', async () => {
    const pending = deferred<string>();
    mockUpload.mockReturnValueOnce(pending.promise);
    const rendered = await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    await rendered.unmount();
    useDraft.getState().reset();
    await act(async () => pending.resolve(blobUrl));
    expect(useDraft.getState().uploads).toEqual([]);
    useDraft.getState().set({ files: [localPhoto] });
    const next = await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    expect(mockUpload).toHaveBeenCalledTimes(2);
    await next.unmount();
    useDraft.getState().set({ files: [] });
    expect(useDraft.getState().uploads).toEqual([]);
  });
  it('보정한 사진은 이전 검사 URL 대신 보정본을 업로드한다', async () => {
    const picked = await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    await picked.unmount();
    const edit = await renderScreen(<PhotoCheckScreen />, client());
    await fireEvent.press(screen.getByText('회전'));
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    await waitFor(() => expect(useDraft.getState().files[0]).toEqual(editedPhoto));
    await edit.unmount();
    expect(useDraft.getState().uploads).toEqual([]);
    await renderScreen(<ConvertScreen />, client());
    await waitFor(() => expect(mockApi.content.createMaterial).toHaveBeenCalled());
    expect(mockUpload).toHaveBeenCalledTimes(2);
    expect(mockUpload.mock.calls[1]?.[1]).toEqual(editedPhoto);
  });
});

it.each([
  ['생물 세포 필기.jpg', '생물 세포 필기.jpg'],
  ['', '필기 자료'],
])('필기 변환 기본 제목은 원본 이름 %s 또는 중립적인 이름을 사용한다', async (fileName, title) => {
  useDraft.getState().set({ title: '', files: [{ ...localPhoto, name: fileName }] });
  await renderScreen(<ConvertScreen />, client());
  await waitFor(() =>
    expect(mockApi.content.createMaterial).toHaveBeenCalledWith(expect.objectContaining({ title })),
  );
});

it.each(['handwriting', 'recording', 'document'])(
  '%s 결과는 예제 제목·과목·파일 크기 대신 조회한 자료를 표시한다',
  async (kind) => {
    mockApi.content.material.mockResolvedValue({
      _id: 'material1',
      folderId: 'folder1',
      title: '생물 세포 학습 자료',
      kind,
      keywords: [],
      bookmarks: [],
      summary: { sections: [], points: [] },
      pages: [],
    });
    await renderScreen(<ResultScreen />, client());
    expect(await screen.findByText('생물 세포 학습 자료')).toBeTruthy();
    expect(screen.queryByText('이차방정식 풀이')).toBeNull();
    expect(screen.queryByText('이온화 에너지와 원자 반지름')).toBeNull();
    expect(screen.queryByText('수학')).toBeNull();
    expect(screen.queryByText('화학')).toBeNull();
    expect(screen.queryByText('2.4MB · 3페이지')).toBeNull();
  },
);

it.each([false, true])(
  '자료 등록 응답 유실 뒤 재시도/재진입(%s)는 같은 중복 방지 ID를 재사용한다',
  async (remount) => {
    mockApi.content.createMaterial.mockRejectedValueOnce(new NetworkError('응답 유실'));
    const first = await renderScreen(<ConvertScreen />, client());
    await screen.findByText('업로드가 잠시 멈췄어요');
    const request = mockApi.content.createMaterial.mock.calls[0][0];
    expect(request.requestId).toEqual(expect.any(String));
    expect(request.requestId.length).toBeGreaterThan(10);
    if (remount) {
      await first.unmount();
      await renderScreen(<ConvertScreen />, client());
    } else await fireEvent.press(screen.getByText('지금 다시 시도'));
    await waitFor(() => expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(2));
    expect(mockApi.content.createMaterial.mock.calls[1][0]).toEqual(request);
    expect(mockUpload).toHaveBeenCalledTimes(1);
  },
);

it.each(['recording', 'document'])(
  '%s 저장 후 상세도 실제 제목·페이지 정보를 표시한다',
  async (kind) => {
    mockApi.content.material.mockResolvedValue({
      _id: 'material1',
      folderId: 'folder1',
      title: '생물 상세 자료',
      kind,
      createdAt: '2026-11-01T00:00:00Z',
      keywords: [],
      bookmarks: [],
      summary: { sections: [], points: [] },
      pages: [{ pageNo: 1 }, { pageNo: 2 }, { pageNo: 3 }, { pageNo: 4 }],
    });
    await renderScreen(kind === 'recording' ? <RecDetailScreen /> : <DocDetailScreen />, client());
    expect(await screen.findByText('생물 상세 자료')).toBeTruthy();
    expect(screen.queryByText('이온화 에너지와 원자 반지름')).toBeNull();
    expect(screen.queryByText('화학')).toBeNull();
    expect(screen.queryByText('수학')).toBeNull();
    if (kind === 'document') {
      expect(screen.getByText(/4페이지/)).toBeTruthy();
      expect(screen.queryByText(/3페이지/)).toBeNull();
    }
  },
);

it('새 초안이나 자료 내용 변경은 이전 등록 키를 재사용하지 않는다', () => {
  const first = useDraft.getState().getCreationId();
  expect(useDraft.getState().getCreationId()).toBe(first);
  useDraft.getState().set({ title: '새로 편집한 자료' });
  const edited = useDraft.getState().getCreationId();
  expect(edited).not.toBe(first);
  useDraft.getState().reset();
  expect(useDraft.getState().getCreationId()).not.toBe(edited);
});

it('실서버 등록 결과가 불명확하면 재등록 버튼 대신 자료 확인 경로를 제공한다', async () => {
  mockApi.content.createMaterial.mockRejectedValueOnce(
    Object.assign(new Error('응답 유실'), { code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
  );
  await renderScreen(<ConvertScreen />, client());
  expect(await screen.findByText('등록 결과를 확인할 수 없어요')).toBeTruthy();
  expect(screen.queryByText('지금 다시 시도')).toBeNull();
  expect(screen.queryByText('다시 시도')).toBeNull();
  await fireEvent.press(screen.getByText('학습자료에서 확인'));
  expect(router.replace).toHaveBeenCalledWith({
    pathname: '/(tabs)/note/folder/[id]',
    params: { id: 'folder1' },
  });
  expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(1);
});

it.each([
  [],
  [
    { index: 0, title: '첫 슬라이드', bullets: [], startSec: 0, endSec: 2 },
    { index: 1, title: '두 번째 슬라이드', bullets: [], startSec: 3, endSec: 5 },
    { index: 2, title: '관계없는 세 번째 슬라이드', bullets: [], startSec: 50, endSec: 60 },
  ],
])(
  '빈 슬라이드나 42초 구간 사이에는 예제·세 번째 슬라이드 대신 빈 상태를 표시한다 (%#)',
  async (...slides) => {
    mockApi.content.recording.mockResolvedValue({
      audioUrl: 'https://blob.example/audio.m4a',
      durationSec: 180,
      slides,
      transcript: { text: '실제 대본', segments: [] },
    });
    await renderScreen(<Player materialId="material1" />, client());
    expect(await screen.findByText('이 구간에는 요약 슬라이드가 없어요')).toBeTruthy();
    expect(screen.queryByText('관계없는 세 번째 슬라이드')).toBeNull();
    expect(screen.queryByText('이온화 에너지 주기적 경향성')).toBeNull();
    expect(screen.queryByText('슬라이드 3 / 0')).toBeNull();
  },
);

it.each([
  { startSec: 40, endSec: 50, visible: true },
  { startSec: 42, endSec: 50, visible: true },
  { startSec: 40, endSec: 42, visible: false },
])(
  '슬라이드 구간 $startSec~$endSec의 42초 표시 경계를 지킨다',
  async ({ startSec, endSec, visible }) => {
    mockApi.content.recording.mockResolvedValue({
      audioUrl: 'https://blob.example/audio.m4a',
      durationSec: 180,
      slides: [{ index: 0, title: '현재 구간 요약', bullets: ['실제 요약'], startSec, endSec }],
      transcript: { text: '', segments: [] },
    });
    await renderScreen(<Player materialId="material1" />, client());
    await screen.findByText('북마크 모음 (0)');
    if (visible) {
      expect(screen.getByText('현재 구간 요약')).toBeTruthy();
      expect(screen.getByText('슬라이드 1 / 1')).toBeTruthy();
    } else {
      expect(screen.queryByText('현재 구간 요약')).toBeNull();
      expect(screen.getByText('이 구간에는 요약 슬라이드가 없어요')).toBeTruthy();
    }
  },
);
