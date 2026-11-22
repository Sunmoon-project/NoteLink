// PROF-004: 설정 맨 위 프로필 줄(학교 · 학년 · 이메일)은 값 있는 것만 ' · '로 잇는다.
// 학교 · 학년이 비면 「 · 이메일」처럼 점으로 시작했다
import { screen } from '@testing-library/react-native';
import type { User } from '@notelink/shared';
import { SettingsScreen } from '../features/profile/settings';
import { seedUser } from './fixtures/seed';
import { renderScreen, setParams } from '../test-utils';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
const mockApi = {
  me: { get: jest.fn(), update: jest.fn(), withdraw: jest.fn() },
  auth: { logout: jest.fn(async () => {}) },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/presence', () => ({ leavePresence: jest.fn(async () => {}) }));
jest.mock('../lib/socket', () => ({ disconnectSocket: jest.fn(), socket: { emit: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
});

async function line(over: Partial<User>) {
  const { school: _s, grade: _g, ...rest } = seedUser();
  mockApi.me.get.mockResolvedValue({ ...rest, ...over });
  await renderScreen(<SettingsScreen />);
  await screen.findByText('설정');
}

it('학교 · 학년이 없으면 이메일만 보이고 앞에 점이 붙지 않는다', async () => {
  await line({ email: 'me@notelink.app' });
  expect(screen.getByText('me@notelink.app')).toBeTruthy();
  expect(screen.queryByText(/·\s*me@notelink\.app/)).toBeNull();
});

it('셋 다 있으면 학교(줄임) · 학년 · 이메일을 점으로 잇는다', async () => {
  await line({ school: '선문고등학교', grade: '3학년', email: 'me@notelink.app' });
  expect(screen.getByText('선문고 · 3학년 · me@notelink.app')).toBeTruthy();
});

it('이메일이 없는 간편 로그인 계정은 끝에 점이 남지 않는다', async () => {
  await line({ school: '선문고등학교', grade: '3학년', email: null });
  expect(screen.getByText('선문고 · 3학년')).toBeTruthy();
});
