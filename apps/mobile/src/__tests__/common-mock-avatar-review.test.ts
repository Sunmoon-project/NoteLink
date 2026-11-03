import { mockApi } from '../lib/mock/api';
import { useMockFlags } from '../lib/mock/flags';
import { useNet } from '../stores/net';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

async function response<T>(promise: Promise<T>): Promise<T> {
  await jest.advanceTimersByTimeAsync(220);
  return promise;
}
beforeEach(() => {
  jest.useFakeTimers();
  useMockFlags.getState().reset();
  useNet.getState().set('ok');
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('실제 목업 saveAvatar는 재조회 가능한 아바타를 저장하고 스타일 변경도 반영한다', async () => {
  const before = await response(mockApi.me.get());
  await response(mockApi.me.saveAvatar({ style: 'nice', gender: 'female', color: '#d9363e' }));
  const first = await response(mockApi.me.get());
  expect(first.avatarUrl).toEqual(expect.any(String));
  expect(first.avatarUrl).toMatch(/^(https?:|data:image\/)/);
  expect(first.avatarUrl).not.toBe(before.avatarUrl);
  await response(mockApi.me.saveAvatar({ style: 'toon', gender: 'male', color: '#2f4f86' }));
  const changed = await response(mockApi.me.get());
  expect(changed.avatarUrl).toEqual(expect.any(String));
  expect(changed.avatarUrl).not.toBe(first.avatarUrl);
});

it('실제 목업 generateProfile의 성공 완료는 사용자 avatarUrl을 변경한다', async () => {
  const before = await response(mockApi.me.get());
  const created = await response(
    mockApi.me.generateProfile({
      photoBlobUrl: 'https://blob/profile/reference.png',
      prompt: '새 학습 프로필',
      style: '수채화',
    }),
  );
  await jest.advanceTimersByTimeAsync(3500);
  const done = await response(mockApi.ai.job(created._id));
  expect(done.status).toBe('succeeded');
  const after = await response(mockApi.me.get());
  expect(after.avatarUrl).toEqual(expect.any(String));
  expect(after.avatarUrl).toMatch(/^(https?:|data:image\/)/);
  expect(after.avatarUrl).not.toBe(before.avatarUrl);
});
