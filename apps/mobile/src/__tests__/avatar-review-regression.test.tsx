import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { AiJob } from '@notelink/shared';
import * as ImagePicker from 'expo-image-picker';
import {
  AvatarCustomScreen,
  PhotoGenScreen,
  PhotoScreen,
  PhotoStyleScreen,
} from '../features/profile/avatar';
import { api } from '../lib/api';
import { SettingsScreen } from '../features/profile/settings';
import { seedUser } from '../lib/mock/seed';
import { mockServer } from '../lib/socket';
import { uploadToBlob } from '../lib/upload';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('../lib/upload', () => ({
  uploadToBlob: jest.fn(async () => 'https://blob/profile.jpg'),
}));
jest.mock('expo-image-picker', () => ({
  CameraType: { front: 'front' },
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('../stores/toast', () => ({ toast: jest.fn() }));
const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
it('canceled 작업은 한 번 복귀한다', async () => {
  Object.assign(router, { dismissTo: jest.fn() });
  jest.spyOn(api.ai, 'job').mockResolvedValue({ _id: 'cancel', status: 'canceled' } as never);
  setParams({ jobId: 'cancel' });
  await renderScreen(<PhotoGenScreen />, qc());
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/profile'));
  expect(router.dismissTo).toHaveBeenCalledTimes(1);
});
it('조회 오류에서 재시도하거나 돌아갈 수 있다', async () => {
  Object.assign(router, { dismissTo: jest.fn() });
  jest.spyOn(api.ai, 'job').mockRejectedValue(new Error('404'));
  setParams({ jobId: 'missing' });
  await renderScreen(<PhotoGenScreen />, qc());
  expect(await screen.findByText('작업 상태를 확인하지 못했어요')).toBeTruthy();
  await fireEvent.press(screen.getByText('돌아가기'));
  expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/profile');
});
it('아바타 저장 실패는 안내하고 성공한 뒤 존재하는 프로필로 복귀한다', async () => {
  const { toast } = jest.requireMock('../stores/toast');
  Object.assign(router, { dismissTo: jest.fn() });
  const save = jest
    .spyOn(api.me, 'saveAvatar')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  setParams({ style: 'nice' });
  await renderScreen(<AvatarCustomScreen />, qc());
  await fireEvent.press(screen.getByText('아바타 선택하기'));
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith('아바타를 저장하지 못했어요. 다시 시도해 주세요'),
  );
  expect(router.dismissTo).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('아바타 선택하기'));
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/profile'));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ style: 'nice' }));
});
it('카메라 권한 거부와 사진 선택 취소는 이동하지 않는다', async () => {
  jest
    .mocked(ImagePicker.requestCameraPermissionsAsync)
    .mockResolvedValue({ granted: false } as never);
  jest
    .mocked(ImagePicker.launchImageLibraryAsync)
    .mockResolvedValue({ canceled: true, assets: null });
  await renderScreen(<PhotoScreen />, qc());
  await fireEvent.press(screen.getByText('카메라로 프로필 만들기'));
  await fireEvent.press(screen.getByText('첨부사진으로 프로필 만들기'));
  expect(router.push).not.toHaveBeenCalled();
});
it('선택한 사진은 Blob 업로드 뒤 생성 API에 URL만 전달한다', async () => {
  const generate = jest
    .spyOn(api.me, 'generateProfile')
    .mockResolvedValue({ _id: 'new-job' } as never);
  setParams({ uri: 'file:///photo.jpg' });
  await renderScreen(<PhotoStyleScreen />, qc());
  await fireEvent.press(screen.getByText('프로필 생성하기 →'));
  await waitFor(() =>
    expect(generate).toHaveBeenCalledWith({
      photoBlobUrl: 'https://blob/profile.jpg',
      prompt: '',
      style: null,
    }),
  );
  expect(uploadToBlob).toHaveBeenCalledWith(
    'image',
    expect.objectContaining({ uri: 'file:///photo.jpg' }),
  );
  await act(async () => {});
  expect(router.replace).toHaveBeenCalledWith({
    pathname: '/(tabs)/profile/photo-gen',
    params: { jobId: 'new-job' },
  });
});

it('프로필 생성 소켓과 상태 조회가 함께 성공해도 복귀와 토스트는 한 번만 처리한다', async () => {
  const { toast } = jest.requireMock('../stores/toast');
  Object.assign(router, { dismissTo: jest.fn() });
  const done: AiJob = {
    _id: 'socket-and-query-success',
    type: 'avatar_profile',
    status: 'succeeded',
    targetType: 'user',
    targetId: 'profile-user',
    progress: 100,
    attempts: 1,
    result: { avatarUrl: 'https://blob/profile/generated.png' },
    error: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:01.000Z',
  };
  let resolve!: (job: AiJob) => void;
  const pending = new Promise<AiJob>((r) => {
    resolve = r;
  });
  const job = jest.spyOn(api.ai, 'job').mockReturnValue(pending);
  const client = qc();
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  setParams({ jobId: done._id });
  await renderScreen(<PhotoGenScreen />, client);
  await waitFor(() => expect(job).toHaveBeenCalledWith(done._id));
  await act(async () => {
    mockServer.push('ai:done', { jobId: done._id, job: done });
    resolve(done);
    await pending;
  });
  await waitFor(() =>
    expect(client.getQueryData<AiJob>(['ai-job', done._id])?.status).toBe('succeeded'),
  );
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/(tabs)/profile'));
  expect(router.dismissTo).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith('새 프로필이 적용됐어요');
  expect(invalidate.mock.calls.filter(([options]) => options?.queryKey?.[0] === 'me')).toHaveLength(
    1,
  );
});

it('아바타 저장 성공은 내 정보 캐시를 무효화해 새 프로필을 다시 조회하게 한다', async () => {
  Object.assign(router, { dismissTo: jest.fn() });
  jest.spyOn(api.me, 'saveAvatar').mockResolvedValue(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(['me'], seedUser());
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  setParams({ style: 'toon' });
  await renderScreen(<AvatarCustomScreen />, client);
  await fireEvent.press(screen.getByText('아바타 선택하기'));
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['me'] }));
  expect(client.getQueryState(['me'])?.isInvalidated).toBe(true);
});

it('설정 프로필은 서버 avatarUrl을 실제 Image로 표시하고 새 URL 재조회도 반영한다', async () => {
  const original = { ...seedUser(), avatarUrl: 'https://blob/profile/previous-avatar.png' };
  const generated = { ...original, avatarUrl: 'https://blob/profile/generated-avatar.png' };
  jest.spyOn(api.me, 'get').mockResolvedValueOnce(original).mockResolvedValue(generated);
  const client = qc();
  setParams({});
  await renderScreen(<SettingsScreen />, client);
  await waitFor(() =>
    expect(screen.getByLabelText('프로필 사진').props.source).toEqual({ uri: original.avatarUrl }),
  );
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['me'] });
  });
  await waitFor(() =>
    expect(screen.getByLabelText('프로필 사진').props.source).toEqual({ uri: generated.avatarUrl }),
  );
});

it.each([
  ['nice', 'Nice Avatar', '👩🏻', '👨🏻'],
  ['3d', '3D Avatar Creator', '👩🏽', '👨🏽'],
  ['toon', 'Cartoon 3D', '👩🏼‍🦱', '👨🏼‍🦱'],
])(
  '선택한 %s 스타일과 성별을 커스터마이징 미리보기에 반영한다',
  async (style, name, female, male) => {
    setParams({ style });
    await renderScreen(<AvatarCustomScreen />, qc());
    expect(screen.getByText(name!)).toBeTruthy();
    expect(screen.getByText(female!)).toBeTruthy();
    await fireEvent.press(screen.getByText('남자'));
    expect(screen.getByText(male!)).toBeTruthy();
  },
);
