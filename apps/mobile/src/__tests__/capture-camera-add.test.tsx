import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { MATERIAL_MAX_FILES } from '@notelink/shared';
import { CameraScreen, PhotoCheckScreen, PickedScreen } from '../features/content/capture';
import { useDraft } from '../stores/draft';
import type { LocalFile } from '../lib/upload';
import { renderScreen, setParams } from '../test-utils';

// #678 카메라로 시작한 필기의 「+ 사진 추가」 · 여러 장일 때 「다시 촬영」 · 사진 확인 보정 대상

const mockApi = { content: { checkImages: jest.fn() } };
const mockTake = jest.fn();
const mockEdit = jest.fn();
const mockToast = jest.fn();
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
jest.mock('../lib/image-edit', () => ({
  editPhoto: (...args: unknown[]) => mockEdit(...args),
  cropPhoto: async (file: unknown) => file,
}));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
  useLocalSearchParams: () => globalThis.mockParams,
  useSegments: () => [],
}));
jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CameraView: React.forwardRef(function MockCameraView(_props: object, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ takePictureAsync: mockTake }));
      return null;
    }),
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
  };
});
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: jest.fn() },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: () => ({}),
  useAudioRecorderState: () => ({}),
}));

const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
};
const photo = (name: string): LocalFile => ({
  uri: `file:///${name}`,
  name,
  size: 1000,
  mimeType: 'image/jpeg',
});
const first = photo('first.jpg');
const second = photo('second.jpg');
const third = photo('third.jpg');
const galleryAsset = {
  uri: 'file:///gallery.jpg',
  fileName: 'gallery.jpg',
  fileSize: 900,
  mimeType: 'image/jpeg',
  width: 100,
  height: 100,
};
const galleryPhoto = {
  uri: galleryAsset.uri,
  name: galleryAsset.fileName,
  size: galleryAsset.fileSize,
  mimeType: galleryAsset.mimeType,
};
const draftFiles = () => useDraft.getState().files;
const shotUri = 'file:///shot.jpg';

beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
  useDraft.getState().reset();
  mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
    files.map((file) => ({ name: file.name, verdict: 'ok' })),
  );
  mockTake.mockResolvedValue({ uri: shotUri, width: 300, height: 400 });
  mockEdit.mockImplementation(async (file: LocalFile, rot: number, crop: boolean) => ({
    ...file,
    uri: `${file.uri}?rot=${rot}&crop=${crop}`,
  }));
  jest
    .mocked(ImagePicker.launchImageLibraryAsync)
    .mockResolvedValue({ canceled: false, assets: [galleryAsset] });
});
afterEach(() => clients.splice(0).forEach((qc) => qc.clear()));

describe('#678 「+ 사진 추가」는 시작한 방법을 따른다', () => {
  it('카메라로 1장 → 사진 추가 → 카메라에서 2장째 → 확인 「다음」이면 찍은 순서대로 2장이고 첫 장은 그대로다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first] });
    const picked = await renderScreen(<PickedScreen />, client());
    await fireEvent.press(screen.getByText('+ 사진 추가'));
    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/capture/camera',
      params: { append: '1' },
    });
    await picked.unmount();

    setParams({ append: '1' });
    const camera = await renderScreen(<CameraScreen />, client());
    await fireEvent.press(screen.getByLabelText('촬영'));
    await waitFor(() => expect(draftFiles()).toHaveLength(2));
    expect(draftFiles()[0]).toBe(first);
    expect(draftFiles()[1]?.uri).toBe(shotUri);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture/photo-check',
      params: { at: '1' },
    });
    await camera.unmount();

    setParams({ at: '1' });
    await renderScreen(<PhotoCheckScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    expect(mockEdit).toHaveBeenCalledWith(expect.objectContaining({ uri: shotUri }), 0, false);
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/capture/picked'));
    expect(draftFiles()).toHaveLength(2);
    expect(draftFiles()[0]).toBe(first);
    expect(draftFiles()[1]?.uri).toBe(`${shotUri}?rot=0&crop=false`);
    // 같은 화면이 두 번 쌓이지 않게: 선택한 사진 화면으로는 replace 하지 않는다
    expect(router.replace).not.toHaveBeenCalledWith('/capture/picked');
  });

  it('갤러리로 시작했으면 사진 추가는 지금처럼 갤러리를 연다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'gallery', files: [first] });
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(screen.getByText('+ 사진 추가'));
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(draftFiles()).toEqual([first, galleryPhoto]);
  });

  it(`남은 칸이 없으면(${MATERIAL_MAX_FILES}장) 카메라로 가지 않고 안내한다`, async () => {
    const full = Array.from({ length: MATERIAL_MAX_FILES }, (_, i) => photo(`p${i}.jpg`));
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: full });
    await renderScreen(<PickedScreen />, client());
    await fireEvent.press(screen.getByText('+ 사진 추가'));
    expect(router.push).not.toHaveBeenCalled();
    expect(ImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      `사진은 한 노트에 ${MATERIAL_MAX_FILES}장까지 올릴 수 있어요`,
    );
  });

  it('처음 촬영(이어 찍기 아님)은 지금처럼 찍은 한 장으로 시작한다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [] });
    await renderScreen(<CameraScreen />, client());
    await fireEvent.press(screen.getByLabelText('촬영'));
    await waitFor(() => expect(draftFiles()).toHaveLength(1));
    expect(draftFiles()[0]?.uri).toBe(shotUri);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture/photo-check',
      params: { at: '0' },
    });
  });

  it('이어 찍기 중 카메라의 갤러리 버튼은 기존 사진 뒤에 붙인다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first] });
    setParams({ append: '1' });
    await renderScreen(<CameraScreen />, client());
    await fireEvent.press(screen.getByLabelText('갤러리'));
    await waitFor(() => expect(draftFiles()).toEqual([first, galleryPhoto]));
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ selectionLimit: MATERIAL_MAX_FILES - 1 }),
    );
    // 카메라로 시작한 초안이므로 다음 「+ 사진 추가」도 카메라로 간다
    expect(useDraft.getState().source).toBe('camera');
    expect(router.dismissTo).toHaveBeenCalledWith('/capture/picked');
  });
});

describe('#678 여러 장일 때 「다시 촬영」은 그 사진만 바꾼다', () => {
  it('흐림 안내 「다시 촬영」은 흐린 사진 자리만 다시 찍는다', async () => {
    mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
      files.map((file) => ({
        name: file.name,
        verdict: file.name.endsWith('second.jpg') ? 'blurry' : 'ok',
      })),
    );
    useDraft
      .getState()
      .set({ kind: 'handwriting', source: 'gallery', files: [first, second, third] });
    const picked = await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    await fireEvent.press(await screen.findByText('다시 촬영'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/capture/camera', params: { at: '1' } });
    expect(router.replace).not.toHaveBeenCalledWith('/capture/camera');
    // 카메라에서 돌아왔을 때 안내창이 그대로 떠 있지 않게 닫는다
    expect(screen.queryByText('글씨를 읽기 어려워요')).toBeNull();
    await picked.unmount();

    setParams({ at: '1' });
    await renderScreen(<CameraScreen />, client());
    await fireEvent.press(screen.getByLabelText('촬영'));
    await waitFor(() => expect(draftFiles()[1]?.uri).toBe(shotUri));
    expect(draftFiles()).toHaveLength(3);
    expect(draftFiles()[0]).toBe(first);
    expect(draftFiles()[2]).toBe(third);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture/photo-check',
      params: { at: '1' },
    });
  });

  it('사진 확인 「다시 촬영」은 지금 확인하는 사진 자리를 넘긴다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first, second] });
    setParams({ at: '1' });
    await renderScreen(<PhotoCheckScreen />, client());
    await fireEvent.press(screen.getByText('다시 촬영'));
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture/camera',
      params: { at: '1' },
    });
    expect(draftFiles()).toEqual([first, second]);
  });

  it('다시 찍는 자리를 고른 카메라의 갤러리 버튼은 그 자리만 한 장으로 바꾼다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first, second] });
    setParams({ at: '0' });
    await renderScreen(<CameraScreen />, client());
    await fireEvent.press(screen.getByLabelText('갤러리'));
    await waitFor(() => expect(draftFiles()).toEqual([galleryPhoto, second]));
    expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: false, selectionLimit: 1 }),
    );
  });

  it('다시 찍을 자리가 목록 밖이면(사진이 지워짐) 기존 사진을 건드리지 않고 뒤에 붙인다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first] });
    setParams({ at: '5' });
    await renderScreen(<CameraScreen />, client());
    await fireEvent.press(screen.getByLabelText('촬영'));
    await waitFor(() => expect(draftFiles()).toHaveLength(2));
    expect(draftFiles()[0]).toBe(first);
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/capture/photo-check',
      params: { at: '1' },
    });
  });

  it('한 장뿐이면 「다시 촬영」은 지금처럼 새로 시작한다(카메라의 갤러리 버튼도 여러 장)', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first] });
    setParams({ at: '0' });
    await renderScreen(<PhotoCheckScreen />, client());
    await fireEvent.press(screen.getByText('다시 촬영'));
    expect(router.replace).toHaveBeenCalledWith('/capture/camera');
  });

  it('흐린 사진이 한 장뿐이면 「다시 촬영」은 자리 없이 카메라를 연다', async () => {
    mockApi.content.checkImages.mockImplementation(async (files: { name: string }[]) =>
      files.map((file) => ({ name: file.name, verdict: 'blurry' })),
    );
    useDraft.getState().set({ kind: 'handwriting', source: 'gallery', files: [first] });
    await renderScreen(<PickedScreen />, client());
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    await fireEvent.press(await screen.findByText('다시 촬영'));
    expect(router.push).toHaveBeenCalledWith('/capture/camera');
  });

  it(`이어 찍기 셔터도 ${MATERIAL_MAX_FILES}장이 차 있으면 붙이지 않고 안내한다`, async () => {
    const full = Array.from({ length: MATERIAL_MAX_FILES }, (_, i) => photo(`p${i}.jpg`));
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: full });
    setParams({ append: '1' });
    await renderScreen(<CameraScreen />, client());
    await fireEvent.press(screen.getByLabelText('촬영'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        `사진은 한 노트에 ${MATERIAL_MAX_FILES}장까지 올릴 수 있어요`,
      ),
    );
    expect(draftFiles()).toEqual(full);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('#678 사진 확인 보정은 대상 사진에만 적용한다', () => {
  it('자리 값이 숫자가 아니면 첫 장을 보여 준다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first, second] });
    setParams({ at: 'abc' });
    await renderScreen(<PhotoCheckScreen />, client());
    await waitFor(() => expect(mockEdit).toHaveBeenCalledWith(first, 0, false));
  });

  it('두 번째 장을 확인하면 회전 · 자르기가 두 번째 장에만 들어가고 첫 장은 그대로다', async () => {
    useDraft.getState().set({ kind: 'handwriting', source: 'camera', files: [first, second] });
    setParams({ at: '1' });
    await renderScreen(<PhotoCheckScreen />, client());
    await fireEvent.press(screen.getByText('회전'));
    await fireEvent.press(screen.getByText('자르기'));
    await waitFor(() => expect(mockEdit).toHaveBeenCalledWith(second, 90, true));
    await waitFor(() => expect(screen.getByRole('button', { name: '다음' })).not.toBeDisabled());
    await fireEvent.press(screen.getByRole('button', { name: '다음' }));
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/capture/picked'));
    expect(draftFiles()[0]).toBe(first);
    expect(draftFiles()[1]?.uri).toBe(`${second.uri}?rot=90&crop=true`);
    expect(mockEdit).not.toHaveBeenCalledWith(first, expect.anything(), expect.anything());
  });
});
