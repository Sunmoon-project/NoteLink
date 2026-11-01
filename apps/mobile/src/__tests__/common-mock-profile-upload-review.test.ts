import { mockApi } from '../lib/mock/api';
import { uploadToBlob } from '../lib/upload';
import { useMockFlags } from '../lib/mock/flags';
import { useNet } from '../stores/net';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
const mockNativeUpload = jest.fn();
jest.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 0 },
  File: jest.fn(() => ({ size: 10, createUploadTask: mockNativeUpload })),
}));

async function response<T>(promise: Promise<T>, elapsed = 220): Promise<T> {
  await jest.advanceTimersByTimeAsync(elapsed);
  return promise;
}
beforeEach(() => {
  jest.useFakeTimers();
  mockNativeUpload.mockClear();
  useMockFlags.getState().reset();
  useNet.setState({ state: 'ok' });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it.each([
  { uri: 'file://picked/profile-photo.png', name: 'profile-photo.png', mimeType: 'image/png' },
  { uri: 'file://picked/profile-photo.jpg', name: 'profile-photo.jpg', mimeType: 'image/jpeg' },
])('실제 목업 업로드→프로필 생성은 존재하는 원본 $name URI를 표시한다', async (file) => {
  // SAS·진행률·작업 생성·완료 콜백은 대체하지 않고 실제 목업 구현을 함께 실행한다.
  const blobUrl = await response(uploadToBlob('image', file), 1000);
  expect(blobUrl).toMatch(/^https:\/\//);
  expect(blobUrl).not.toBe(file.uri);
  expect(mockNativeUpload).not.toHaveBeenCalled();
  const created = await response(
    mockApi.me.generateProfile({
      photoBlobUrl: blobUrl,
      prompt: '사진을 프로필로 사용',
      style: '수채화',
    }),
  );
  await jest.advanceTimersByTimeAsync(3500);
  const done = await response(mockApi.ai.job(created._id));
  expect(done.status).toBe('succeeded');
  const user = await response(mockApi.me.get());
  expect({ profile: user.avatarUrl, result: done.result }).toEqual({
    profile: file.uri,
    result: { avatarUrl: file.uri },
  });
});
