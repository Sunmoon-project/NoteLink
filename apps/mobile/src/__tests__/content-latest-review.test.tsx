import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { imageCheckName, PhotoCheckScreen, PickedScreen } from '../features/content/capture';
import { ApiError } from '../lib/api/http';
import { DocDetailScreen, HandDetailScreen, RecDetailScreen } from '../features/content/detail';
import { Player } from '../features/content/player';
import { ConvertScreen, ResultScreen } from '../features/content/convert';
import { FolderScreen } from '../features/content/notes';
import { NetworkError } from '../lib/api';
import { useAuth } from '../stores/auth';
import { useDraft } from '../stores/draft';
import { renderScreen, setParams } from '../test-utils';

jest.mock('expo-router', () => ({
  useIsFocused: () => true,
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
    folders: jest.fn(),
    materials: jest.fn(),
  },
};
const mockUpload = jest.fn();
const mockCheckFile = jest.fn();
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
  checkFile: (...args: unknown[]) => mockCheckFile(...args),
  uploadToBlob: (...args: unknown[]) => mockUpload(...args),
}));
jest.mock('../lib/image-edit', () => ({ editPhoto: (...args: unknown[]) => mockEdit(...args) }));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
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
  mockCheckFile.mockReturnValue({ ok: true });
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
  mockApi.content.folders.mockResolvedValue([
    { _id: 'folder1', title: '학습 폴더', subjectName: '생물', createdAt: '2026-11-01T00:00:00Z' },
  ]);
  mockApi.content.materials.mockResolvedValue([
    {
      _id: 'registered-material',
      title: '서버에서 확인한 자료',
      kind: 'handwriting',
      createdAt: '2026-11-01T00:00:00Z',
    },
  ]);
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
  const manyPhotos = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...localPhoto,
      uri: `file:///picked-${i}.jpg`,
      name: `picked-${i}.jpg`,
    }));
  it('노트 등록 상한(50장)을 넘으면 검사하지 않고 줄이라고 안내한다', async () => {
    useDraft.getState().set({ files: manyPhotos(51) });
    await renderScreen(<PickedScreen />, client());
    expect(await screen.findByText('사진은 한 노트에 50장까지 올릴 수 있어요')).toBeTruthy();
    expect(screen.getByText('1장을 빼면 검사를 시작해요')).toBeTruthy();
    expect(screen.getAllByText('검사 전')).toHaveLength(51);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockApi.content.checkImages).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '다음' })).toBeDisabled();
  });
  // 실제 업로드처럼 사진마다 다른 주소
  const uniqueUploads = () =>
    mockUpload.mockImplementation(async (_kind: string, f: { name: string }) =>
      Promise.resolve(`https://blob.example/${f.name}`),
    );
  it('20장이 넘으면 서버 상한(20장)씩 나눠 차례로 검사하고 결과를 합친다', async () => {
    uniqueUploads();
    useDraft.getState().set({ files: manyPhotos(45) });
    await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(3));
    expect(mockApi.content.checkImages.mock.calls.map(([files]) => files.length)).toEqual([
      20, 20, 5,
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    expect(screen.getAllByText('올릴 수 있어요')).toHaveLength(45);
  });
  it('뒤 묶음이 실패해도 다시 검사할 때 이미 검사한 묶음은 다시 보내지 않는다', async () => {
    uniqueUploads();
    useDraft.getState().set({ files: manyPhotos(45) });
    mockApi.content.checkImages
      .mockImplementationOnce(async (files: { name: string }[]) =>
        files.map((file) => ({ name: file.name, verdict: 'ok' })),
      )
      .mockImplementationOnce(async (files: { name: string }[]) =>
        files.map((file) => ({ name: file.name, verdict: 'ok' })),
      )
      .mockRejectedValueOnce(new ApiError('AI_UNAVAILABLE', '사진 검사 실패', 503));
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(await screen.findByText('다시 검사'));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(4));
    expect(mockApi.content.checkImages.mock.calls[3][0]).toHaveLength(5);
    expect(mockUpload).toHaveBeenCalledTimes(45);
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
  });
  it('400이면 실패한 묶음의 사진만 다시 올리고, 통과한 묶음은 그대로 쓴다', async () => {
    uniqueUploads();
    useDraft.getState().set({ files: manyPhotos(45) });
    mockApi.content.checkImages
      .mockImplementationOnce(async (files: { name: string }[]) =>
        files.map((file) => ({ name: file.name, verdict: 'ok' })),
      )
      .mockRejectedValueOnce(new ApiError('BAD_REQUEST', '사용할 수 없는 사진입니다.', 400));
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(await screen.findByText('다시 검사'));
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    // 처음: 1 · 2묶음 40장 올림 → 다시: 2묶음 20장 다시 + 3묶음 5장
    expect(mockUpload).toHaveBeenCalledTimes(65);
    expect(mockApi.content.checkImages.mock.calls.map(([files]) => files.length)).toEqual([
      20, 20, 20, 5,
    ]);
  });
  it('올리는 도중 사진 목록이 바뀌면 앞 검사의 남은 사진은 올리지 않는다', async () => {
    const first = deferred<string>();
    mockUpload.mockImplementationOnce(() => first.promise);
    mockUpload.mockImplementation(async (_kind: string, f: { name: string }) =>
      Promise.resolve(`https://blob.example/${f.name}`),
    );
    const photos = manyPhotos(10);
    useDraft.getState().set({ files: photos });
    await renderScreen(<PickedScreen />, client());
    // 첫 4장을 올리는 중
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(4));
    // 마지막 사진 1장을 빼면 새 검사가 9장으로 시작한다
    await act(async () => useDraft.getState().set({ files: photos.slice(0, 9) }));
    await act(async () => first.resolve('https://blob.example/picked-0.jpg'));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(1));
    // 앞 검사는 나머지 6장을 올리지 않고, 새 검사만 9장을 검사한다
    expect(mockApi.content.checkImages.mock.calls[0][0]).toHaveLength(9);
    const names = mockUpload.mock.calls.map(([, f]) => (f as { name: string }).name);
    expect(names.filter((n) => n === 'picked-9.jpg')).toHaveLength(0);
  });
  it('사진은 4장씩 나눠 올린다', async () => {
    let running = 0;
    let most = 0;
    mockUpload.mockImplementation(async (_kind: string, f: { name: string }) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return `https://blob.example/${f.name}`;
    });
    useDraft.getState().set({ files: manyPhotos(10) });
    await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(1));
    expect(most).toBe(4);
  });
  it('서버가 올린 파일을 받지 않으면(400) 다시 검사할 때 새로 올린다', async () => {
    mockApi.content.checkImages.mockRejectedValueOnce(
      new ApiError('BAD_REQUEST', '사용할 수 없는 사진입니다.', 400),
    );
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(await screen.findByText('다시 검사'));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(2));
    expect(mockUpload).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
  });
  it('서버 오류(5xx)로 실패하면 다시 검사할 때 올린 파일을 다시 쓴다', async () => {
    mockApi.content.checkImages.mockRejectedValueOnce(
      new ApiError('AI_UNAVAILABLE', '사진 검사 서비스를 사용할 수 없어요.', 503),
    );
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(await screen.findByText('다시 검사'));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(2));
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });
  it('형식 · 용량에서 모두 걸리면 빈 목록으로 서버를 부르지 않는다', async () => {
    mockCheckFile.mockReturnValue({ ok: false });
    useDraft.getState().set({
      files: [{ ...localPhoto, uri: 'file:///note.gif', name: 'note.gif', mimeType: 'image/gif' }],
    });
    await renderScreen(<PickedScreen />, client());
    expect(await screen.findByText('올릴 수 없는 파일이에요')).toBeTruthy();
    expect(mockApi.content.checkImages).not.toHaveBeenCalled();
    expect(screen.queryByText('사진 검사에 실패했어요. 다시 시도해 주세요.')).toBeNull();
  });
  it('검사 이름은 서버처럼 255자 · 앞뒤 공백 없이, 글자를 반쪽 내지 않고 자른다', () => {
    expect(imageCheckName(0, 'a.jpg')).toBe('0-a.jpg');
    // 255번째에서 잘리면 끝이 공백 → 서버가 지우므로 미리 지운다
    const spaced = imageCheckName(3, `${'가'.repeat(252)} 나머지.jpg`);
    expect(spaced).toBe(`3-${'가'.repeat(252)}`);
    // 이모지(두 단위)가 경계에 걸리면 통째로 뺀다
    const emoji = imageCheckName(0, `${'a'.repeat(252)}😀b`);
    expect(emoji).toBe(`0-${'a'.repeat(252)}`);
    expect(emoji.length).toBeLessThanOrEqual(255);
  });
  it('긴 이름의 사진도 자른 이름으로 검사 결과를 맞춘다', async () => {
    const longName = `${'가'.repeat(300)}.jpg`;
    useDraft.getState().set({ files: [{ ...localPhoto, name: longName }] });
    await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalled());
    expect(mockApi.content.checkImages.mock.calls[0][0][0].name).toBe(imageCheckName(0, longName));
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
  });
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
  describe('문서 원본 문서 탭: PDF는 쪽 이미지 대신 원본 파일 열기만', () => {
    const withPage = (imageUrl: string) =>
      mockApi.content.material.mockResolvedValue({
        ...{ _id: 'material1', folderId: 'folder1', title: '문서', kind: 'document' },
        createdAt: '2026-11-01T00:00:00Z',
        keywords: [],
        bookmarks: [],
        summary: { sections: [], points: [] },
        pages: [{ _id: 'page1', pageNo: 1, imageUrl, ocrText: null, takenAt: null }],
      });
    const openTab = async () => {
      setParams({ id: 'material1', tab: '원본 문서' });
      await renderScreen(<DocDetailScreen />, client());
      await screen.findByText('원본 파일 열기');
    };

    it.each([
      ['PDF', 'https://blob.example/u/a.pdf'],
      ['SAS 쿼리가 붙은 PDF', 'https://blob.example/u/a.pdf?sv=2024&sp=r&sig=abc'],
      ['대문자 확장자', 'https://blob.example/u/A.PDF'],
      ['대문자 확장자 + 쿼리', 'https://blob.example/u/A.PDF?sig=x%2Fy'],
    ])('%s면 쪽 이미지를 그리지 않고 안내와 버튼만 보인다', async (_name, imageUrl) => {
      withPage(imageUrl);
      await openTab();
      expect(screen.getByText('PDF는 원본 파일 열기로 볼 수 있어요')).toBeTruthy();
      expect(screen.queryByLabelText('1페이지 원본')).toBeNull();
    });

    it.each([
      ['이미지', 'https://blob.example/u/scan.jpg'],
      ['쿼리 안에 .pdf가 든 이미지', 'https://blob.example/u/scan.jpg?name=a.pdf'],
    ])('%s면 쪽 이미지가 보이고 PDF 안내는 없다', async (_name, imageUrl) => {
      withPage(imageUrl);
      await openTab();
      expect(screen.getByLabelText('1페이지 원본')).toBeTruthy();
      expect(screen.queryByText('PDF는 원본 파일 열기로 볼 수 있어요')).toBeNull();
    });
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
    // 실제 업로드처럼 올릴 때마다 다른 주소
    mockUpload.mockImplementation(
      async () => `https://blob.example/upload-${mockUpload.mock.calls.length}.jpg`,
    );
    await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    const second = { ...localPhoto, uri: 'file:///second.jpg', name: 'second.jpg' };
    await act(async () => useDraft.getState().set({ files: [localPhoto, second] }));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    expect(mockUpload).toHaveBeenCalledTimes(2);
    // 이미 검사한 사진은 다시 보내지 않고 새 사진만 검사한다
    expect(mockApi.content.checkImages.mock.calls[1][0]).toEqual([
      expect.objectContaining({ name: `1-${second.name}` }),
    ]);
    await act(async () => useDraft.getState().set({ files: [{ ...localPhoto }, second] }));
    await waitFor(() => expect(mockApi.content.checkImages).toHaveBeenCalledTimes(3));
    expect(mockUpload).toHaveBeenCalledTimes(3);
    expect(mockApi.content.checkImages.mock.calls[2][0]).toEqual([
      expect.objectContaining({ name: `0-${localPhoto.name}` }),
    ]);
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

it('실서버 등록 결과가 불명확하면 같은 등록 키로 다시 시도하거나 자료 목록에서 확인할 수 있다', async () => {
  mockApi.content.createMaterial
    .mockRejectedValueOnce(
      Object.assign(new Error('응답 유실'), { code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
    )
    .mockRejectedValueOnce(
      Object.assign(new Error('응답 유실'), { code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
    );
  await renderScreen(<ConvertScreen />, client());
  expect(await screen.findByText('등록 결과를 확인할 수 없어요')).toBeTruthy();
  expect(screen.queryByText('지금 다시 시도')).toBeNull();
  await fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(2));
  const [first, second] = mockApi.content.createMaterial.mock.calls.map((c) => c[0]);
  expect(second.requestId).toBe(first.requestId);
  expect(router.dismissTo).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByText('학습자료에서 확인'));
  expect(router.dismissTo).toHaveBeenCalledWith({
    pathname: '/(tabs)/note/folder/[id]',
    params: { id: 'folder1' },
  });
  expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(2);
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

it('불명확한 등록 확인은 30초 이내 빈 목록 캐시도 실제 재조회하고 폴더에 결과를 표시한다', async () => {
  mockApi.content.createMaterial.mockRejectedValueOnce(
    Object.assign(new Error('응답 유실'), { code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
  );
  const qc = client();
  qc.setDefaultOptions({ queries: { retry: false, staleTime: 30000, gcTime: Infinity } });
  qc.setQueryData(['materials', 'folder1'], []);
  const convert = await renderScreen(<ConvertScreen />, qc);
  await fireEvent.press(await screen.findByText('학습자료에서 확인'));
  expect(mockApi.content.materials).toHaveBeenCalledWith('folder1');
  expect(mockToast).toHaveBeenCalledWith(
    '목록에 없으면 저장을 마치지 못한 자료예요. 필요하면 다시 올려주세요',
  );
  await convert.unmount();
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />, qc);
  expect(await screen.findByText('서버에서 확인한 자료')).toBeTruthy();
  expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(1);
});

it('등록 여부 조회가 실패하면 안내하고 같은 조회만 재시도하며 등록은 반복하지 않는다', async () => {
  mockApi.content.createMaterial.mockRejectedValueOnce(
    Object.assign(new Error('응답 유실'), { code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
  );
  mockApi.content.materials.mockRejectedValueOnce(new Error('목록 조회 실패'));
  await renderScreen(<ConvertScreen />, client());
  await fireEvent.press(await screen.findByText('학습자료에서 확인'));
  expect(mockToast).toHaveBeenCalledWith(
    '등록 여부를 확인하지 못했어요. 연결을 확인하고 다시 눌러주세요',
  );
  expect(router.replace).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('학습자료에서 확인'));
  expect(mockApi.content.materials).toHaveBeenCalledTimes(2);
  expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(1);
  expect(router.dismissTo).toHaveBeenCalled();
});

it('등록 목록 확인을 기다리다 화면을 나가면 늦은 응답으로 다시 이동하지 않는다', async () => {
  mockApi.content.createMaterial.mockRejectedValueOnce(
    Object.assign(new Error('응답 유실'), { code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
  );
  const pending = deferred<never[]>();
  mockApi.content.materials.mockReturnValueOnce(pending.promise);
  const rendered = await renderScreen(<ConvertScreen />, client());
  await userEvent.setup().press(await screen.findByText('학습자료에서 확인'));
  await waitFor(() => expect(mockApi.content.materials).toHaveBeenCalledTimes(1));
  await rendered.unmount();
  await act(async () => pending.resolve([]));
  expect(router.dismissTo).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
  expect(mockApi.content.createMaterial).toHaveBeenCalledTimes(1);
});

it('등록 목록 확인 중 계정이 바뀌면 이전 결과를 캐시나 화면 이동에 반영하지 않는다', async () => {
  const owner = useAuth.getState().userId;
  mockApi.content.createMaterial.mockRejectedValueOnce(
    Object.assign(new Error('응답 유실'), { code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
  );
  const pending = deferred<{ _id: string }[]>();
  mockApi.content.materials.mockReturnValueOnce(pending.promise);
  const qc = client();
  qc.setQueryData(['materials', 'folder1'], []);
  try {
    await renderScreen(<ConvertScreen />, qc);
    await userEvent.setup().press(await screen.findByText('학습자료에서 확인'));
    await waitFor(() => expect(mockApi.content.materials).toHaveBeenCalledTimes(1));
    useAuth.setState({ userId: 'different-owner' });
    await act(async () => pending.resolve([{ _id: 'old-owner-material' }]));
    expect(qc.getQueryData(['materials', 'folder1'])).toEqual([]);
    expect(router.replace).not.toHaveBeenCalled();
  } finally {
    useAuth.setState({ userId: owner });
  }
});

describe('PR36 자료 표시는 실제 값만 쓴다', () => {
  it('필기 과목은 소속 폴더 값을 쓰고, 폴더를 못 찾으면 생략한다', async () => {
    setParams({ id: 'material1' });
    const first = await renderScreen(<HandDetailScreen />, client());
    expect(await screen.findByText('생물')).toBeTruthy();
    expect(screen.queryByText('수학')).toBeNull();
    await first.unmount();

    mockApi.content.folders.mockResolvedValue([]);
    await renderScreen(<HandDetailScreen />, client());
    await screen.findByText('실제 업로드 자료');
    await waitFor(() => expect(mockApi.content.folders).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText('과목')).toBeNull();
  });

  it.each([
    ['done', '자동 요약 완료'],
    ['failed', '요약 실패'],
    ['processing', '요약 중'],
  ])('녹음 목록은 처리 상태 %s를 %s로 표시하고 고정 길이를 쓰지 않는다', async (status, label) => {
    mockApi.content.materials.mockResolvedValue([
      {
        _id: 'rec1',
        title: '녹음 자료',
        kind: 'recording',
        createdAt: '2026-11-01T00:00:00Z',
        processing: { status, progress: 0, jobId: null },
      },
    ]);
    setParams({ id: 'folder1' });
    await renderScreen(<FolderScreen />, client());
    expect(await screen.findByText(new RegExp(`11/1 업로드 · ${label}$`))).toBeTruthy();
    expect(screen.queryByText(/32:10/)).toBeNull();
  });
});

it('폴더 자료 목록 경로가 서버에 없어도(404) 자료 0개 폴더는 실패 대신 빈 폴더로 보여 준다', async () => {
  mockApi.content.folders.mockResolvedValue([
    {
      _id: 'folder1',
      title: '11월 15일 수학',
      subjectName: '수학',
      createdAt: '2026-11-15T00:00:00Z',
      materialCount: 0,
    },
  ]);
  mockApi.content.materials.mockRejectedValue(
    Object.assign(new Error('Cannot GET'), { status: 404 }),
  );
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />, client());
  await waitFor(() => expect(mockApi.content.materials).toHaveBeenCalled());
  expect(await screen.findByText('아직 학습 자료가 없어요')).toBeTruthy();
  expect(screen.queryByText('자료를 불러오지 못했어요')).toBeNull();
  expect(screen.queryByText('자료 다시 시도')).toBeNull();
});

it('자료가 있다고 센 폴더의 목록을 못 읽으면 지금처럼 실패와 다시 시도를 보여 준다', async () => {
  mockApi.content.folders.mockResolvedValue([
    {
      _id: 'folder1',
      title: '11월 15일 수학',
      subjectName: '수학',
      createdAt: '2026-11-15T00:00:00Z',
      materialCount: 2,
    },
  ]);
  mockApi.content.materials.mockRejectedValue(
    Object.assign(new Error('Cannot GET'), { status: 404 }),
  );
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />, client());
  expect(await screen.findByText('자료를 불러오지 못했어요')).toBeTruthy();
});

it('받아 둔 자료 목록이 있으면 다시 읽기가 404여도 빈 폴더로 덮지 않는다', async () => {
  mockApi.content.folders.mockResolvedValue([
    {
      _id: 'folder1',
      title: '11월 15일 수학',
      subjectName: '수학',
      createdAt: '2026-11-15T00:00:00Z',
      materialCount: 0,
    },
  ]);
  mockApi.content.materials.mockRejectedValue(
    Object.assign(new Error('Cannot GET'), { status: 404 }),
  );
  const qc = client();
  qc.setQueryData(
    ['materials', 'folder1'],
    [
      {
        _id: 'm1',
        title: '받아 둔 자료',
        kind: 'document',
        createdAt: '2026-11-15T00:00:00Z',
        processing: { status: 'done', progress: 100, jobId: null },
      },
    ],
  );
  setParams({ id: 'folder1' });
  await renderScreen(<FolderScreen />, qc);
  expect(await screen.findByText('받아 둔 자료')).toBeTruthy();
  await act(async () => {
    await qc.refetchQueries({ queryKey: ['materials', 'folder1'] });
  });
  expect(screen.getByText('받아 둔 자료')).toBeTruthy();
  expect(screen.queryByText('아직 학습 자료가 없어요')).toBeNull();
});
