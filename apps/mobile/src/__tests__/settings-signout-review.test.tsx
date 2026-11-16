import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { SettingsScreen } from '../features/profile/settings';
import { seedUser } from './fixtures/seed';
import { disconnectSocket } from '../lib/socket';
import { useAuth } from '../stores/auth';
import { useDraft } from '../stores/draft';
import { useQuizProgress } from '../stores/quiz-progress';
import { useSession } from '../stores/session';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockStore.delete(key)),
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
jest.mock('../lib/socket', () => ({ disconnectSocket: jest.fn(), socket: { emit: jest.fn() } }));

const user = { ...seedUser(), _id: 'settings-signout-user' };
const tokens = { accessToken: 'settings-access', refreshToken: 'settings-refresh' };
const clients: QueryClient[] = [];
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
  useSession.getState().reset();
  useDraft.getState().reset();
  useQuizProgress.getState().reset();
  useToast.getState().hide();
  mockApi.me.get.mockResolvedValue(user);
  setParams({});
});
afterEach(() => {
  clients.forEach((qc) => qc.clear());
  clients.length = 0;
});

async function confirmSignOut() {
  await fireEvent.press(await screen.findByRole('button', { name: '로그아웃' }));
  expect(await screen.findByText('로그아웃할까요?')).toBeTruthy();
  const buttons = screen.getAllByRole('button', { name: '로그아웃' });
  await fireEvent.press(buttons[buttons.length - 1]!);
}

it('설정 로그아웃의 기기 삭제 실패는 모든 계정 상태를 보존하고 성공한 재시도에서만 비운다', async () => {
  await useAuth.getState().signIn(tokens, user);
  await useAuth.getState().finishOnboarding();
  useSession.setState({
    itemId: 'studying-item',
    sessionId: 'active-session',
    since: 12345,
    banked: 42,
    pausedAt: null,
    mode: 'personal',
  });
  useDraft.getState().set({
    folderId: 'my-folder',
    title: '저장 전 노트',
    files: [{ uri: 'file:///original.jpg', name: 'original.jpg', mimeType: 'image/jpeg' }],
  });
  useQuizProgress.getState().save({
    setId: 'my-quiz',
    attemptId: 'my-attempt',
    index: 1,
    answerText: '작성 중 답안',
    pick: null,
    right: null,
    results: [true],
  });
  const originalSession = { ...useSession.getState() };
  const originalDraft = { ...useDraft.getState() };
  const originalProgress = useQuizProgress.getState().progress;
  const originalAuth = { ...useAuth.getState() };
  const savedAuth = mockStore.get('notelink.auth');
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(qc);
  const privateData = { note: '개인 학습 기록' };
  qc.setQueryData(['private-signout-data'], privateData);
  qc.setQueryData(['me'], user);
  jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('기기 삭제 실패'));
  await renderScreen(<SettingsScreen />, qc);
  await confirmSignOut();
  await waitFor(() =>
    expect(useToast.getState().msg).toBe(
      '기기의 로그인 정보를 지우지 못했어요. 다시 시도해 주세요',
    ),
  );
  expect(useSession.getState()).toEqual(originalSession);
  expect(useDraft.getState()).toEqual(originalDraft);
  expect(useQuizProgress.getState().progress).toEqual(originalProgress);
  expect(qc.getQueryData(['private-signout-data'])).toEqual(privateData);
  expect(qc.getQueryData(['me'])).toEqual(user);
  expect(useAuth.getState()).toEqual(originalAuth);
  expect(mockStore.get('notelink.auth')).toBe(savedAuth);
  expect(disconnectSocket).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();

  await confirmSignOut();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/login'));
  expect(useAuth.getState()).toMatchObject({
    tokens: null,
    user: null,
    userId: null,
    onboarded: false,
  });
  expect(useSession.getState()).toMatchObject({
    itemId: null,
    sessionId: null,
    since: null,
    banked: 0,
  });
  expect(useDraft.getState()).toMatchObject({ folderId: null, title: '', files: [] });
  expect(useQuizProgress.getState().progress).toBeNull();
  expect(qc.getQueryData(['private-signout-data'])).toBeUndefined();
  expect(mockStore.has('notelink.auth')).toBe(false);
  expect(disconnectSocket).toHaveBeenCalledTimes(1);
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(2);
});
