import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { LoginScreen } from '../features/auth/auth';
import { seedUser } from './fixtures/seed';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { ApiError } from '../lib/api';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

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
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ disconnectSocket: jest.fn(), socket: { emit: jest.fn() } }));

const A = { ...seedUser(), _id: 'account-a', nickname: 'A' };
const B = { ...seedUser(), _id: 'account-b', nickname: 'B' };
const tokens = { accessToken: 'access-a', refreshToken: 'refresh-a' };
const setId = 'quiz-auth-review';
const attemptId = 'attempt-before-login';
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(qc);
  return qc;
}
async function signedIn(onboarded = true) {
  await useAuth.getState().signIn(tokens, A);
  if (onboarded) await useAuth.getState().finishOnboarding();
}
function saveProgress() {
  useQuizProgress.getState().save({
    setId,
    attemptId,
    index: 1,
    answerText: '기억할 답',
    pick: null,
    right: null,
    results: [true],
  });
}
async function submitLogin() {
  await fireEvent.press(screen.getByText('이메일로 로그인'));
  await fireEvent.changeText(screen.getByPlaceholderText('you@example.com'), 'learner@example.com');
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), 'password-a');
  await fireEvent.press(screen.getByText('로그인'));
  await screen.findByRole('button', { name: '로그인' });
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
  useQuizProgress.getState().reset();
  useToast.getState().hide();
  mockApi.auth.emailLogin.mockResolvedValue({ user: A, ...tokens });
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
  useQuizProgress.getState().reset();
});

it('다른 계정 로그인은 이전 풀이·개인 캐시를 비우고 약관으로 이동한다', async () => {
  await signedIn();
  saveProgress();
  const qc = client();
  qc.setQueryData(['private-account-a'], { note: '이전 계정 자료' });
  mockApi.auth.emailLogin.mockResolvedValue({
    user: B,
    accessToken: 'access-b',
    refreshToken: 'refresh-b',
  });
  await renderScreen(<LoginScreen />, qc);
  await submitLogin();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/terms'));
  expect(useAuth.getState()).toMatchObject({ userId: B._id, onboarded: false });
  expect(useQuizProgress.getState().progress).toBeNull();
  expect(qc.getQueryData(['private-account-a'])).toBeUndefined();
  expect(qc.getQueryData(['me'])).toEqual(B);
});

it('같은 계정이라도 온보딩 전이면 풀이 복원보다 약관을 먼저 표시한다', async () => {
  await signedIn(false);
  saveProgress();
  await renderScreen(<LoginScreen />, client());
  await submitLogin();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/terms'));
  expect(useQuizProgress.getState().progress?.attemptId).toBe(attemptId);
});

it('온보딩 완료 계정에 미완료 풀이가 없으면 홈으로 이동한다', async () => {
  await signedIn();
  await renderScreen(<LoginScreen />, client());
  await submitLogin();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
});

it('로그인 정보 저장 실패는 안내하고 화면을 이동하지 않으며 다시 로그인할 수 있다', async () => {
  await signedIn();
  const qc = client();
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('기기 저장 실패'));
  await renderScreen(<LoginScreen />, qc);
  await submitLogin();
  expect(await screen.findByText('로그인하지 못했어요')).toBeTruthy();
  expect(router.replace).not.toHaveBeenCalled();
  expect(qc.getQueryData(['me'])).toBeUndefined();
  await fireEvent.press(screen.getByText('로그인'));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
  expect(mockApi.auth.emailLogin).toHaveBeenCalledTimes(2);
});

it('로그아웃 저장 삭제 실패 시 인증 상태를 유지하고 성공한 재시도에서만 비운다', async () => {
  await signedIn();
  jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('기기 삭제 실패'));
  await expect(useAuth.getState().signOut()).rejects.toThrow('기기 삭제 실패');
  expect(useAuth.getState()).toMatchObject({ userId: A._id, tokens, onboarded: true });
  await useAuth.getState().signOut();
  expect(useAuth.getState()).toMatchObject({ userId: null, tokens: null, onboarded: false });
});

it('온보딩 완료 동일 계정의 미완료 풀이가 있으면 해당 세트 ID로 복귀한다', async () => {
  await signedIn();
  saveProgress();
  const previous = useQuizProgress.getState().progress;
  await renderScreen(<LoginScreen />, client());
  await submitLogin();
  await waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith({ pathname: '/play/solve', params: { setId } }),
  );
  expect(useQuizProgress.getState().progress).toEqual(previous);
});

it('로그인 실패는 시트 안에 안내하고, 입력을 고치면 지운다', async () => {
  const failure = new ApiError('VALIDATION_FAILED', '', 400);
  failure.message = '이메일 또는 비밀번호가 맞지 않아요';
  mockApi.auth.emailLogin.mockRejectedValueOnce(failure);
  await renderScreen(<LoginScreen />, client());
  await submitLogin();
  expect(await screen.findByText('이메일 또는 비밀번호가 맞지 않아요')).toBeTruthy();
  await fireEvent.changeText(screen.getByPlaceholderText('8자 이상'), '123456789');
  expect(screen.queryByText('이메일 또는 비밀번호가 맞지 않아요')).toBeNull();
});
