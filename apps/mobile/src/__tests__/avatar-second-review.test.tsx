import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import type { AiJob } from '@notelink/shared';
import { PhotoScreen, PhotoStyleScreen } from '../features/profile/avatar';
import { api } from '../lib/api';
import { uploadToBlob } from '../lib/upload';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('../lib/upload', () => ({
  uploadToBlob: jest.fn(async () => 'https://blob/profile.png'),
}));
jest.mock('expo-image-picker', () => ({
  CameraType: { front: 'front' },
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

const png = {
  uri: 'file:///portrait.png',
  width: 320,
  height: 320,
  fileName: 'portrait.png',
  mimeType: 'image/png',
  fileSize: 12345,
};
const job: AiJob = {
  _id: 'profile-png-job',
  type: 'avatar_profile',
  status: 'queued',
  targetType: 'user',
  targetId: 'me',
  progress: 0,
  attempts: 1,
  result: null,
  error: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(qc);
  return qc;
};
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(ImagePicker.launchImageLibraryAsync)
    .mockResolvedValue({ canceled: false, assets: [png] });
  jest.spyOn(api.me, 'generateProfile').mockResolvedValue(job);
  setParams({});
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  jest.restoreAllMocks();
});

it('갤러리에서 고른 PNG의 파일명과 MIME을 프로필 형태 화면으로 넘긴다', async () => {
  await renderScreen(<PhotoScreen />, client());
  await fireEvent.press(screen.getByText('첨부사진으로 프로필 만들기'));
  expect(router.push).toHaveBeenCalledWith({
    pathname: '/(tabs)/profile/photo-style',
    params: expect.objectContaining({ uri: png.uri, name: png.fileName, mimeType: png.mimeType }),
  });
});

it('프로필 형태 화면은 전달받은 PNG를 JPEG로 위장하지 않고 원래 메타데이터로 올린다', async () => {
  setParams({ uri: png.uri, name: png.fileName, mimeType: png.mimeType });
  await renderScreen(<PhotoStyleScreen />, client());
  await fireEvent.press(screen.getByText('프로필 생성하기 →'));
  await waitFor(() =>
    expect(uploadToBlob).toHaveBeenCalledWith(
      'image',
      expect.objectContaining({ uri: png.uri, name: png.fileName, mimeType: png.mimeType }),
    ),
  );
  expect(api.me.generateProfile).toHaveBeenCalledWith(
    expect.objectContaining({ photoBlobUrl: 'https://blob/profile.png' }),
  );
});

it('형태 화면에서 JPEG를 PNG로 다시 고르면 업로드 파일명·MIME도 새 사진으로 바뀐다', async () => {
  setParams({ uri: 'file:///old.jpg', name: 'old.jpg', mimeType: 'image/jpeg' });
  await renderScreen(<PhotoStyleScreen />, client());
  await fireEvent.press(screen.getByText('사진이 준비됐어요'));
  await fireEvent.press(screen.getByText('프로필 생성하기 →'));
  await waitFor(() =>
    expect(uploadToBlob).toHaveBeenCalledWith(
      'image',
      expect.objectContaining({ uri: png.uri, name: png.fileName, mimeType: png.mimeType }),
    ),
  );
});
