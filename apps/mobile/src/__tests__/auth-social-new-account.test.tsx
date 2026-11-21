import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { LoginScreen, NEW_ACCOUNT_NOTICE } from '../features/auth/auth';
import { seedUser } from './fixtures/seed';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

// PROF-013(#637): 탈퇴한 계정은 되살리지 않는다. 탈퇴 뒤 같은 소셜 계정으로 들어오면 서버가 새 계정을 만들고
// isNewUser: true 를 보낸다(처음 가입도 같다). 앱은 그때만 「새 계정으로 가입했어요」를 알리고 약관으로 보낸다

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockStore.delete(key)),
}));
const mockApi = {
  auth: { emailLogin: jest.fn(), socialLogin: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ disconnectSocket: jest.fn(), socket: { emit: jest.fn() } }));
// 간편 로그인 버튼을 켜고, 제공자 로그인 창(시스템 브라우저)은 건너뛴다
jest.mock('../lib/social-auth', () => ({
  socialLoginReady: true,
  getProviderToken: jest.fn(async () => ({ token: 'one-time-code', codeVerifier: 'verifier' })),
}));

const fresh = { ...seedUser(), _id: 'new-account', nickname: '새 계정', onboarded: false };
const tokens = { accessToken: 'access-new', refreshToken: 'refresh-new' };

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function pressKakao() {
  await renderScreen(<LoginScreen />, client());
  await fireEvent.press(screen.getByLabelText('카카오로 시작하기'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  useAuth.setState({
    ready: true,
    tokens: null,
    user: null,
    userId: null,
    onboarded: false,
    expired: false,
  });
  useToast.getState().hide();
});

it('간편 로그인이 새 계정을 만들었으면 새 계정임과 탈퇴 계정은 되살리지 않음을 알리고 약관으로 보낸다', async () => {
  mockApi.auth.socialLogin.mockResolvedValue({ user: fresh, ...tokens, isNewUser: true });

  await pressKakao();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/terms'));
  // 처음 가입한 사람에게도 뜨므로(서버는 재가입인지 모른다) 탈퇴했다고 단정하지 않는 조건문이다
  expect(NEW_ACCOUNT_NOTICE).toBe(
    '새 계정으로 가입했어요. 예전에 탈퇴한 계정이 있었다면 그 기록은 되살릴 수 없어요',
  );
  expect(useToast.getState().msg).toBe(NEW_ACCOUNT_NOTICE);
  expect(useAuth.getState().userId).toBe('new-account');
});

it('이미 있는 계정으로 로그인하면(isNewUser: false) 안내하지 않는다', async () => {
  mockApi.auth.socialLogin.mockResolvedValue({ user: fresh, ...tokens, isNewUser: false });

  await pressKakao();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/terms'));
  expect(useToast.getState().msg).toBeNull();
});

it('새 계정 여부를 보내지 않는 옛 서버와 만나도 안내 없이 지금처럼 이어진다', async () => {
  mockApi.auth.socialLogin.mockResolvedValue({ user: fresh, ...tokens });

  await pressKakao();

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/terms'));
  expect(useToast.getState().msg).toBeNull();
});

it('로그인 정보를 기기에 저장하지 못하면 새 계정 안내 대신 실패를 알리고 이동하지 않는다', async () => {
  mockApi.auth.socialLogin.mockResolvedValue({ user: fresh, ...tokens, isNewUser: true });
  const SecureStore = jest.requireMock('expo-secure-store') as {
    setItemAsync: jest.Mock;
  };
  SecureStore.setItemAsync.mockRejectedValueOnce(new Error('keychain'));

  await pressKakao();

  await waitFor(() => expect(useToast.getState().msg).not.toBeNull());
  expect(useToast.getState().msg).not.toBe(NEW_ACCOUNT_NOTICE);
  expect(router.replace).not.toHaveBeenCalled();
});
