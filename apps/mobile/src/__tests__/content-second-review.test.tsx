import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { PickedScreen, RecLiveScreen } from '../features/content/capture';
import { NoteListScreen } from '../features/content/notes';
import { useDraft } from '../stores/draft';
import { renderScreen, setParams } from '../test-utils';

const mockApi = { content: { checkImages: jest.fn(), folders: jest.fn() }, me: { get: jest.fn() } };
const mockActivate = jest.fn(async (_tag: string) => {});
const mockDeactivate = jest.fn((_tag: string) => {});
const mockRecorder = {
  uri: 'file:///recorded.m4a',
  prepareToRecordAsync: jest.fn(async () => {}),
  record: jest.fn(),
  pause: jest.fn(),
  stop: jest.fn(async () => {}),
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/upload', () => ({
  checkFile: () => ({ ok: true }),
  uploadToBlob: async (_kind: string, file: { name: string }) =>
    `https://blob.example/${file.name}`,
}));
jest.mock('../lib/image-edit', () => ({ editPhoto: jest.fn() }));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    setParams: jest.fn((params: Record<string, string | undefined>) => {
      globalThis.mockParams = { ...globalThis.mockParams, ...params };
    }),
  },
  useLocalSearchParams: () => globalThis.mockParams,
  useSegments: () => [],
  useFocusEffect: () => {},
}));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, jest.fn()],
}));
jest.mock('expo-keep-awake', () => ({
  useKeepAwake: (tag: string) => {
    jest.requireActual<typeof import('react')>('react').useEffect(() => {
      void mockActivate(tag);
      return () => mockDeactivate(tag);
    }, [tag]);
  },
  activateKeepAwakeAsync: (tag: string) => mockActivate(tag),
  deactivateKeepAwake: (tag: string) => mockDeactivate(tag),
}));
jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: true })) },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(async () => {}),
  useAudioRecorder: () => mockRecorder,
  useAudioRecorderState: () => ({ isRecording: true, durationMillis: 1000, metering: -40 }),
}));
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
};
const firstPhoto = {
  uri: 'file:///existing.jpg',
  name: 'existing.jpg',
  size: 1200,
  mimeType: 'image/jpeg',
};
const addedAsset = {
  uri: 'file:///added.jpg',
  fileName: 'added.jpg',
  fileSize: 900,
  mimeType: 'image/jpeg',
  width: 100,
  height: 100,
};
const addedPhoto = {
  uri: addedAsset.uri,
  name: addedAsset.fileName,
  size: addedAsset.fileSize,
  mimeType: addedAsset.mimeType,
};
const folder = (id: string, title: string) => ({
  _id: id,
  title,
  subjectName: '수학',
  materialCount: 0,
  updatedAt: '2026-11-01T00:00:00Z',
  createdAt: '2026-11-01T00:00:00Z',
});
const me = (keep: boolean) => ({
  _id: 'recorder-user',
  settings: { keepScreenOnWhileRecording: keep },
});
beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
  useDraft.getState().reset();
  useDraft.getState().set({ files: [firstPhoto], kind: 'handwriting' });
  mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
    files.map((file) => ({ name: file.name, verdict: 'ok' })),
  );
  mockApi.content.folders.mockResolvedValue([folder('folder1', '기존 폴더')]);
  mockApi.me.get.mockResolvedValue(me(false));
  jest
    .mocked(ImagePicker.launchImageLibraryAsync)
    .mockResolvedValue({ canceled: false, assets: [addedAsset] });
});
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

describe('PR36 사진 추가와 다시 선택', () => {
  it('사진 추가는 기존 선택 뒤에 새 사진을 붙인다', async () => {
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(screen.getByText('+ 사진 추가'));
    expect(useDraft.getState().files).toEqual([firstPhoto, addedPhoto]);
    expect(await screen.findByText('선택한 사진 (2장)')).toBeTruthy();
  });
  it('사진 다시 선택은 기존 선택을 새 목록으로 교체한다', async () => {
    mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
      files.map((file) => ({ name: file.name, verdict: 'not_handwriting' })),
    );
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(await screen.findByText('사진 다시 선택'));
    expect(useDraft.getState().files).toEqual([addedPhoto]);
  });
  it('사진 추가 선택을 취소하면 기존 사진을 그대로 유지한다', async () => {
    jest
      .mocked(ImagePicker.launchImageLibraryAsync)
      .mockResolvedValue({ canceled: true, assets: null });
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(screen.getByText('+ 사진 추가'));
    expect(useDraft.getState().files).toEqual([firstPhoto]);
  });
});

describe('PR36 업로드 진입 파라미터 소비', () => {
  it.each([true, false])(
    '최초 폴더 존재=%s일 때 진입을 한 번만 처리하고 폴더 갱신에 재진입하지 않는다',
    async (hasFolder) => {
      mockApi.content.folders.mockResolvedValue(hasFolder ? [folder('folder1', '기존 폴더')] : []);
      setParams({ upload: 'hand' });
      const qc = client();
      await renderScreen(<NoteListScreen />, qc);
      await waitFor(() => expect(router.push).toHaveBeenCalledTimes(1));
      expect(router.push).toHaveBeenCalledWith(
        hasFolder
          ? { pathname: '/(tabs)/note/folder/[id]', params: { id: 'folder1', upload: 'hand' } }
          : '/note-new/tag',
      );
      await act(async () => qc.setQueryData(['folders'], [folder('folder2', '갱신된 폴더')]));
      await screen.findByText('갱신된 폴더');
      expect(router.push).toHaveBeenCalledTimes(1);
      expect(router.setParams).toHaveBeenCalledWith({ upload: undefined });
      expect(globalThis.mockParams.upload).toBeUndefined();
    },
  );
});

describe('PR36 녹음 화면 켜 두기 설정', () => {
  it('저장 설정이 false이면 녹음을 시작해도 화면 잠금 방지를 활성화하지 않는다', async () => {
    mockApi.me.get.mockResolvedValue(me(false));
    await renderScreen(<RecLiveScreen />, client());
    await waitFor(() => expect(mockRecorder.record).toHaveBeenCalled());
    expect(mockActivate).not.toHaveBeenCalled();
  });
  it('저장 설정이 true이면 녹음 화면에서 활성화하고 나갈 때 해제한다', async () => {
    mockApi.me.get.mockResolvedValue(me(true));
    const rendered = await renderScreen(<RecLiveScreen />, client());
    await waitFor(() => expect(mockActivate).toHaveBeenCalledWith('recording'));
    await rendered.unmount();
    expect(mockDeactivate).toHaveBeenCalledWith('recording');
  });
  it('녹음 중 설정이 true에서 false로 바뀌면 잠금 방지를 해제한다', async () => {
    mockApi.me.get.mockResolvedValue(me(true));
    const qc = client();
    await renderScreen(<RecLiveScreen />, qc);
    await waitFor(() => expect(mockActivate).toHaveBeenCalledWith('recording'));
    await act(async () => qc.setQueryData(['me'], me(false)));
    await waitFor(() => expect(mockDeactivate).toHaveBeenCalledWith('recording'));
  });
});
