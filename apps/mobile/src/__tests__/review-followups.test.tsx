import * as SecureStore from 'expo-secure-store';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router, useSitemap } from 'expo-router';
import type { User } from '@notelink/shared';
import { SettingsScreen, AccountScreen } from '../features/profile/settings';
import { useAuth } from '../stores/auth';
import { useSession } from '../stores/session';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

const mockDisk = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockDisk.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockDisk.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockDisk.delete(k)),
}));
const mockApi = {
  me: { get: jest.fn(), update: jest.fn(), withdraw: jest.fn() },
  study: {
    startSession: jest.fn(),
    pauseSession: jest.fn(async () => {}),
    resumeSession: jest.fn(async () => {}),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/env', () => ({ env: { useMock: false } }));
const user = {
  _id: 'user-a',
  nickname: '테스터',
  settings: {
    resumePlayback: false,
    subtitleLanguage: '한국어',
    pageTurn: 'swipe',
    theme: 'light',
  },
} as User;
const tokens = { accessToken: 'a', refreshToken: 'r' };

beforeEach(() => {
  jest.clearAllMocks();
  mockDisk.clear();
  useToast.setState({ msg: null });
  useAuth.setState({ tokens: null, userId: null, user: null, onboarded: false });
  useSession.getState().reset();
  mockApi.me.get.mockResolvedValue(user);
});

it('인증 저장 실패를 호출자에게 알리고 다음 저장은 계속 진행한다', async () => {
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('write failed'));
  await expect(useAuth.getState().signIn(tokens, user)).rejects.toThrow('write failed');
  await expect(useAuth.getState().signIn(tokens, user)).resolves.toBeUndefined();
  expect(mockDisk.get('notelink.auth')).toContain('user-a');
});

it('로그아웃 저장 삭제 실패를 성공으로 처리하지 않는다', async () => {
  await useAuth.getState().signIn(tokens, user);
  jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('delete failed'));
  await expect(useAuth.getState().signOut()).rejects.toThrow('delete failed');
  await useAuth.getState().signOut();
  expect(mockDisk.has('notelink.auth')).toBe(false);
});

it('시작 확인 전 정지·재개를 허용하지 않고 서버 응답 후 측정한다', async () => {
  let answer!: (s: { _id: string }) => void;
  mockApi.study.startSession.mockReturnValueOnce(
    new Promise((r) => {
      answer = r;
    }),
  );
  const starting = useSession.getState().start('item-a');
  expect(useSession.getState().since).toBeNull();
  expect(useSession.getState().elapsed()).toBe(0);
  useSession.getState().pause();
  useSession.getState().resume();
  expect(useSession.getState().pausedAt).toBeNull();
  expect(useSession.getState().since).toBeNull();
  answer({ _id: 'session-a' });
  await starting;
  expect(useSession.getState().since).not.toBeNull();
  expect(mockApi.study.pauseSession).not.toHaveBeenCalled();
  expect(mockApi.study.resumeSession).not.toHaveBeenCalled();
  useSession.getState().pause();
  expect(mockApi.study.pauseSession).toHaveBeenCalledWith('session-a');
});

it('설정은 저장 응답 전 화면에 반영하고 성공 뒤 서버 값을 다시 받는다', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let answer!: (u: User) => void;
  mockApi.me.update.mockReturnValueOnce(
    new Promise((r) => {
      answer = r;
    }),
  );
  await renderScreen(<SettingsScreen />, qc);
  await fireEvent(await screen.findByLabelText('이어듣기'), 'valueChange', true);
  await waitFor(() => expect(qc.getQueryData<User>(['me'])?.settings.resumePlayback).toBe(true));
  const saved = { ...user, settings: { ...user.settings, resumePlayback: true } };
  mockApi.me.get.mockResolvedValue(saved);
  answer(saved);
  await waitFor(() => expect(mockApi.me.get).toHaveBeenCalledTimes(2));
  expect(mockApi.me.update).toHaveBeenCalledWith({ settings: { resumePlayback: true } });
});

it('설정 저장 실패 뒤 서버 값으로 화면을 복구한다', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reject!: (e: Error) => void;
  mockApi.me.update.mockReturnValueOnce(
    new Promise((_, r) => {
      reject = r;
    }),
  );
  await renderScreen(<SettingsScreen />, qc);
  await fireEvent(await screen.findByLabelText('이어듣기'), 'valueChange', true);
  await waitFor(() => expect(qc.getQueryData<User>(['me'])?.settings.resumePlayback).toBe(true));
  reject(new Error('save failed'));
  await waitFor(() => expect(qc.getQueryData<User>(['me'])?.settings.resumePlayback).toBe(false));
});

it('제공되지 않은 화면으로 이동하지 않는다', async () => {
  jest.mocked(useSitemap).mockReturnValue(null);
  await renderScreen(<SettingsScreen />);
  await fireEvent.press(await screen.findByText('캘린더 바로가기'));
  await fireEvent.press(screen.getByText('상점 바로가기'));
  await fireEvent.press(screen.getByLabelText('프로필 사진 변경'));
  expect(router.push).not.toHaveBeenCalled();
});

it('다른 PR의 화면이 등록되면 같은 진입점에서 이동할 수 있다', async () => {
  const avatar = {
    contextKey: './(tabs)/profile/avatar-style.tsx',
    filename: 'avatar-style.tsx',
    href: '/(tabs)/profile/avatar-style',
    isInitial: false,
    isInternal: false,
    isGenerated: false,
    children: [],
  };
  jest.mocked(useSitemap).mockReturnValue({ ...avatar, href: '/', children: [avatar] });
  await renderScreen(<AccountScreen />);
  await fireEvent.press(await screen.findByText('아바타 설정하기'));
  expect(router.push).toHaveBeenCalledWith('/(tabs)/profile/avatar-style');
});

it('회원 탈퇴 실패 시 로그인 상태를 유지하고 재시도를 안내한다', async () => {
  await useAuth.getState().signIn(tokens, user);
  mockApi.me.withdraw.mockRejectedValueOnce(new Error('server unavailable'));
  await renderScreen(<SettingsScreen />);
  await fireEvent.press(await screen.findByText('회원 탈퇴'));
  await fireEvent.press(await screen.findByText('탈퇴하기'));
  expect(useAuth.getState().tokens).toBe(tokens);
  expect(router.replace).not.toHaveBeenCalled();
  expect(useToast.getState().msg).toContain('탈퇴');
});
