import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { User } from '@notelink/shared';
import { AppOverlays } from '../components/AppOverlays';
import { ProfileSetupScreen } from '../features/auth/auth';
import { SettingsScreen } from '../features/profile/settings';
import { useAuth } from '../stores/auth';
import { useSession } from '../stores/session';
import { renderScreen } from '../test-utils';

const mockStore = new Map<string, string>();
let mockDelay = 0;
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    await new Promise((r) => setTimeout(r, mockDelay));
    mockStore.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));
const mockApi = {
  me: {
    get: jest.fn(),
    update: jest.fn(),
    interestCategories: jest.fn(async () => []),
    withdraw: jest.fn(async () => {}),
  },
  auth: { logout: jest.fn(async () => {}) },
  study: {
    startSession: jest.fn(),
    endSession: jest.fn(async () => ({ durationSec: 0, pointsEarned: 0 })),
    pauseSession: jest.fn(async () => {}),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));

const A = { accessToken: 'a', refreshToken: 'a-r' };
const B = { accessToken: 'b', refreshToken: 'b-r' };
const user = (id: string) => ({ _id: id, nickname: id }) as unknown as User;

beforeEach(() => {
  mockStore.clear();
  mockDelay = 0;
  useAuth.setState({ tokens: null, user: null, userId: null, onboarded: false, expired: false });
});

// PR #32 Codex 2차 리뷰
describe('인증 저장', () => {
  it('갱신 토큰을 저장하는 사이 B로 로그인하면 B 상태가 남는다', async () => {
    await useAuth.getState().signIn(A, user('u-a'));
    mockDelay = 30;
    const refreshing = useAuth
      .getState()
      .setTokens({ accessToken: 'a2', refreshToken: 'a-r2' }, 'u-a');
    await useAuth.getState().signIn(B, user('u-b'));
    await refreshing;
    expect(useAuth.getState()).toMatchObject({ userId: 'u-b', tokens: B });
    expect(JSON.parse(mockStore.get('notelink.auth')!)).toMatchObject({
      userId: 'u-b',
      accessToken: 'b',
    });
  });

  it('다른 계정의 갱신 결과는 반영하지 않는다', async () => {
    await useAuth.getState().signIn(B, user('u-b'));
    expect(
      await useAuth.getState().setTokens({ accessToken: 'a2', refreshToken: 'x' }, 'u-a'),
    ).toBe(false);
    expect(useAuth.getState().tokens).toBe(B);
  });

  it('만료되면 토큰만 버리고 같은 계정의 온보딩은 남긴다', async () => {
    await useAuth.getState().signIn(A, user('u-a'));
    await useAuth.getState().finishOnboarding();
    await useAuth.getState().expire();
    expect(useAuth.getState()).toMatchObject({ tokens: null, userId: 'u-a', onboarded: true });
    await useAuth.getState().signIn(A, user('u-a'));
    expect(useAuth.getState().onboarded).toBe(true);
  });
});

describe('로그인 만료 안내', () => {
  it('만료되면 다시 로그인 화면으로 보낸다', async () => {
    await useAuth.getState().signIn(A, user('u-a'));
    useAuth.setState({ expired: true });
    await renderScreen(<AppOverlays />);
    await fireEvent.press(await screen.findByText('다시 로그인'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(auth)/login'));
    expect(useAuth.getState()).toMatchObject({ tokens: null, expired: false, userId: 'u-a' });
  });
});

describe('측정 세션 시작 대기', () => {
  beforeEach(() => {
    useSession.getState().reset();
    mockApi.study.startSession.mockReset();
    mockApi.study.pauseSession.mockClear();
  });

  it('앞 세션을 끝내는 사이 계정이 바뀌면 새로 시작하지 않는다', async () => {
    useSession.setState({ itemId: 'i1', sessionId: 's1', since: Date.now() });
    let finish!: () => void;
    mockApi.study.endSession.mockReturnValueOnce(
      new Promise((r) => (finish = () => r({ durationSec: 1, pointsEarned: 0 }))) as never,
    );
    const p = useSession.getState().start('i2');
    useSession.getState().reset();
    finish();
    await p;
    expect(mockApi.study.startSession).not.toHaveBeenCalled();
    expect(useSession.getState().itemId).toBeNull();
  });

  it('응답 전에는 대기하고 시작 확인 뒤에만 일시정지한다', async () => {
    let answer!: (v: { _id: string }) => void;
    mockApi.study.startSession.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const p = useSession.getState().start('i1');
    useSession.getState().pause();
    expect(useSession.getState()).toMatchObject({ since: null, pausedAt: null });
    answer({ _id: 's-new' });
    await p;
    expect(mockApi.study.pauseSession).not.toHaveBeenCalled();
    useSession.getState().pause();
    expect(mockApi.study.pauseSession).toHaveBeenCalledWith('s-new');
  });
});

describe('설정 · 온보딩', () => {
  it('내 정보를 못 불러와도 로그아웃할 수 있다', async () => {
    await useAuth.getState().signIn(A, user('u-a'));
    mockApi.me.get.mockRejectedValue(new Error('401'));
    await renderScreen(<SettingsScreen />);
    await fireEvent.press(await screen.findByText('로그아웃', {}, { timeout: 8000 }));
    await waitFor(() => expect(useAuth.getState().tokens).toBeNull());
    expect(router.replace).toHaveBeenCalledWith('/(auth)/login');
  });

  it('프로필 설정을 저장하면 온보딩을 마치고 홈으로 간다', async () => {
    await useAuth.getState().signIn(A, user('u-a'));
    mockApi.me.update.mockResolvedValue(user('u-a'));
    await renderScreen(<ProfileSetupScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('노트러버'), '한결');
    await fireEvent.press(screen.getByText('대학생'));
    await fireEvent.press(screen.getByText('시작하기'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    expect(mockApi.me.update).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: '한결', learnerType: 'university' }),
    );
    expect(useAuth.getState().onboarded).toBe(true);
  });

  it('회원 탈퇴는 확인 뒤 서버에 탈퇴를 보내고 로그인 화면으로 간다', async () => {
    await useAuth.getState().signIn(A, user('u-a'));
    mockApi.me.get.mockResolvedValue({
      ...user('u-a'),
      settings: { subtitleLanguage: '한국어', pageTurn: 'swipe', theme: 'light' },
      usage: { storageBytes: 0, storageLimitBytes: 1, aiCredits: 0, aiCreditLimit: 1 },
    });
    await renderScreen(<SettingsScreen />);
    await fireEvent.press(await screen.findByText('회원 탈퇴', {}, { timeout: 8000 }));
    await fireEvent.press(await screen.findByText('탈퇴하기'));
    await waitFor(() => expect(mockApi.me.withdraw).toHaveBeenCalled());
    await waitFor(() => expect(useAuth.getState().userId).toBeNull());
  });
});

it('쓰는 곳 없는 필기 · 자막 언어 · 다크 테마 설정은 보이지 않는다', async () => {
  await useAuth.getState().signIn(A, user('u-a'));
  mockApi.me.get.mockResolvedValue({
    ...user('u-a'),
    settings: { subtitleLanguage: '한국어', pageTurn: 'swipe', theme: 'light' },
    usage: { storageBytes: 0, storageLimitBytes: 1, aiCredits: 0, aiCreditLimit: 1 },
  });
  await renderScreen(<SettingsScreen />);
  expect(await screen.findByText('회원 탈퇴', {}, { timeout: 8000 })).toBeTruthy();
  expect(screen.queryByText('더블 탭으로 지우개 전환')).toBeNull();
  expect(screen.queryByText('왼손잡이 모드')).toBeNull();
  // 서버가 있어야 하는 자막 언어, 다크 테마도 두지 않는다
  expect(screen.queryByText('자막 기본 언어')).toBeNull();
  expect(screen.queryByText('다크')).toBeNull();
});
