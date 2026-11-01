import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { HomeScreen } from '../features/session/home';
import { AddItemSheet } from '../features/session/sheets';
import { useAuth } from '../stores/auth';
import { useSession } from '../stores/session';
import { renderScreen } from '../test-utils';

const mockNow = Date.now();
const oldItem = {
  _id: 'old-item',
  title: '기존 공부',
  subjectName: '수학',
  goalMin: 60,
  accumulatedSec: 0,
};
const nextItem = {
  _id: 'next-item',
  title: '새 공부',
  subjectName: '영어',
  goalMin: 30,
  accumulatedSec: 0,
};
const mockApi = {
  me: { get: jest.fn() },
  calendar: { ddays: jest.fn() },
  study: {
    today: jest.fn(),
    weekly: jest.fn(),
    weeklyGoal: jest.fn(),
    subjects: jest.fn(),
    startSession: jest.fn(),
    endSession: jest.fn(),
    pauseSession: jest.fn(),
    resumeSession: jest.fn(),
    addItem: jest.fn(),
  },
};
const mockToast = jest.fn();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../stores/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
jest.mock('../lib/feature-navigation', () => ({ useFeatureNavigation: () => jest.fn() }));
jest.mock('../hooks', () => ({ ...jest.requireActual('../hooks'), useNow: () => mockNow }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-sensors', () => ({
  Accelerometer: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    setUpdateInterval: jest.fn(),
  },
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: jest.fn() }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: {},
}));
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const startOldSession = () =>
  useSession.setState({
    itemId: oldItem._id,
    sessionId: 'old-session',
    since: mockNow - 5000,
    pausedAt: null,
  });
beforeEach(() => {
  jest.clearAllMocks();
  useSession.getState().reset();
  useAuth.setState({
    userId: 'account-a',
    user: null,
    tokens: { accessToken: 'access-a', refreshToken: 'refresh-a' },
    ready: true,
  });
  mockApi.me.get.mockResolvedValue({ _id: 'account-a', nickname: '테스트 학습자', streakDays: 0 });
  mockApi.calendar.ddays.mockResolvedValue([]);
  mockApi.study.today.mockResolvedValue({ items: [oldItem, nextItem], totalSec: 0 });
  mockApi.study.weekly.mockResolvedValue({ totalSec: 0, diffFromLastWeekSec: 0, days: [] });
  mockApi.study.weeklyGoal.mockResolvedValue({ targetMin: 1260, notify80: false });
  mockApi.study.subjects.mockResolvedValue([{ _id: 'math', name: '수학' }]);
  mockApi.study.startSession.mockReset().mockResolvedValue({ _id: 'new-session' });
  mockApi.study.endSession.mockReset().mockResolvedValue({ durationSec: 12, pointsEarned: 5 });
  mockApi.study.pauseSession.mockResolvedValue(undefined);
  mockApi.study.resumeSession.mockResolvedValue(undefined);
  mockApi.study.addItem.mockReset().mockResolvedValue({ ...nextItem, _id: 'added-item' });
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  useSession.getState().reset();
});

describe('PR34 시작 및 항목 전환 실패', () => {
  it('시작 요청 실패를 처리하고 안내하며 미시작 상태를 유지한다', async () => {
    mockApi.study.startSession.mockRejectedValue(new Error('시작 요청 실패'));
    await renderScreen(<HomeScreen />, client());
    const start = await screen.findByLabelText('새 공부 시작');
    await expect(fireEvent.press(start)).resolves.toBeUndefined();
    expect(mockToast).toHaveBeenCalled();
    expect(useSession.getState()).toMatchObject({ sessionId: null, itemId: null, since: null });
    expect(router.push).not.toHaveBeenCalled();
  });
  it('항목 전환 중 기존 세션 종료 실패를 처리하고 새 시작을 보내지 않는다', async () => {
    startOldSession();
    mockApi.study.endSession.mockRejectedValue(new Error('기존 측정 종료 실패'));
    await renderScreen(<HomeScreen />, client());
    const start = await screen.findByLabelText('새 공부 시작');
    await expect(fireEvent.press(start)).resolves.toBeUndefined();
    expect(mockToast).toHaveBeenCalled();
    expect(mockApi.study.startSession).not.toHaveBeenCalled();
    expect(useSession.getState()).toMatchObject({ sessionId: 'old-session', itemId: oldItem._id });
  });
});

describe('PR34 종료 응답의 계정·세션 유효성', () => {
  it.each(['logout', 'account-switch', 'session-replacement'] as const)(
    '종료 대기 중 %s가 일어나면 이전 요약을 열지 않는다',
    async (change) => {
      startOldSession();
      const pending = deferred<{ durationSec: number; pointsEarned: number }>();
      mockApi.study.endSession.mockReturnValue(pending.promise);
      await renderScreen(<HomeScreen />, client());
      const ending = fireEvent.press(await screen.findByText('종료'));
      await waitFor(() => expect(mockApi.study.endSession).toHaveBeenCalledTimes(1));
      await act(async () => {
        if (change === 'logout') await useAuth.getState().signOut();
        else if (change === 'account-switch')
          useAuth.setState({
            userId: 'account-b',
            tokens: { accessToken: 'access-b', refreshToken: 'refresh-b' },
          });
        useSession.getState().reset();
        if (change === 'session-replacement') await useSession.getState().start(nextItem._id);
      });
      await act(async () => pending.resolve({ durationSec: 999, pointsEarned: 99 }));
      await ending;
      expect(
        jest
          .mocked(router.push)
          .mock.calls.some(
            ([href]) =>
              typeof href === 'object' &&
              href !== null &&
              'pathname' in href &&
              href.pathname === '/summary',
          ),
      ).toBe(false);
      if (change === 'session-replacement')
        expect(useSession.getState().sessionId).toBe('new-session');
    },
  );
  it('같은 계정과 세션의 정상 종료는 실제 시간과 포인트로 요약을 연다', async () => {
    startOldSession();
    await renderScreen(<HomeScreen />, client());
    await fireEvent.press(await screen.findByText('종료'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/summary',
      params: { sec: '12', points: '5' },
    });
  });
});

it('공부 항목 추가 실패를 알리고 입력을 유지한 채 같은 값으로 재시도한다', async () => {
  const onClose = jest.fn();
  mockApi.study.addItem.mockRejectedValueOnce(new Error('항목 추가 실패'));
  await renderScreen(<AddItemSheet open onClose={onClose} />, client());
  await fireEvent.changeText(screen.getByPlaceholderText('이차방정식 풀이'), '재시도할 공부');
  await fireEvent.press(screen.getByText('+ 새 과목'));
  await fireEvent.changeText(screen.getByPlaceholderText('새 과목 이름 (20자까지)'), '물리');
  await fireEvent.press(screen.getByText('직접 입력'));
  await fireEvent.changeText(screen.getByPlaceholderText('목표 시간 (분)'), '37');
  await fireEvent.press(screen.getByText('추가하기'));
  await waitFor(() => expect(mockToast).toHaveBeenCalled());
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText('이차방정식 풀이').props.value).toBe('재시도할 공부');
  expect(screen.getByPlaceholderText('새 과목 이름 (20자까지)').props.value).toBe('물리');
  expect(screen.getByPlaceholderText('목표 시간 (분)').props.value).toBe('37');
  await fireEvent.press(screen.getByText('추가하기'));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  const payload = { title: '재시도할 공부', subjectName: '물리', goalMin: 37 };
  expect(mockApi.study.addItem.mock.calls.map(([input]) => input)).toEqual([payload, payload]);
});

describe('PR34 종료 중 인증 갱신과 재로그인 구분', () => {
  it('같은 계정의 정상 토큰 갱신은 완료 요약 이동을 막지 않는다', async () => {
    startOldSession();
    const pending = deferred<{ durationSec: number; pointsEarned: number }>();
    mockApi.study.endSession.mockReturnValue(pending.promise);
    await renderScreen(<HomeScreen />, client());
    const ending = fireEvent.press(await screen.findByText('종료'));
    await waitFor(() => expect(mockApi.study.endSession).toHaveBeenCalledTimes(1));
    await act(async () => {
      await useAuth
        .getState()
        .setTokens({ accessToken: 'refreshed-a', refreshToken: 'refreshed-r' }, 'account-a');
    });
    await act(async () => pending.resolve({ durationSec: 123, pointsEarned: 7 }));
    await ending;
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/summary',
      params: { sec: '123', points: '7' },
    });
  });
  it('로그아웃 후 같은 계정과 같은 토큰으로 재로그인해도 이전 종료 응답을 버린다', async () => {
    startOldSession();
    const tokens = useAuth.getState().tokens!;
    const user = await mockApi.me.get();
    const pending = deferred<{ durationSec: number; pointsEarned: number }>();
    mockApi.study.endSession.mockReturnValue(pending.promise);
    await renderScreen(<HomeScreen />, client());
    const ending = fireEvent.press(await screen.findByText('종료'));
    await waitFor(() => expect(mockApi.study.endSession).toHaveBeenCalledTimes(1));
    await act(async () => {
      await useAuth.getState().signOut();
      useSession.getState().reset();
      expect(useAuth.getState().tokens).toBeNull();
      await useAuth.getState().signIn(tokens, user);
    });
    expect(useAuth.getState().userId).toBe('account-a');
    expect(useAuth.getState().tokens).toBe(tokens);
    await act(async () => pending.resolve({ durationSec: 999, pointsEarned: 99 }));
    await ending;
    expect(
      jest
        .mocked(router.push)
        .mock.calls.some(
          ([href]) =>
            typeof href === 'object' &&
            href !== null &&
            'pathname' in href &&
            href.pathname === '/summary',
        ),
    ).toBe(false);
  });
});

it('기존 세션 종료 성공 후 새 시작만 실패해도 저장된 공부 시간을 재조회해 표시한다', async () => {
  startOldSession();
  let previousEnded = false;
  mockApi.study.today.mockImplementation(async () => ({
    items: [{ ...oldItem, accumulatedSec: previousEnded ? 12 : 0 }, nextItem],
    totalSec: previousEnded ? 12 : 0,
  }));
  mockApi.study.weekly.mockImplementation(async () => ({
    totalSec: previousEnded ? 12 : 0,
    diffFromLastWeekSec: 0,
    days: [],
  }));
  mockApi.study.endSession.mockImplementation(async () => {
    previousEnded = true;
    return { durationSec: 12, pointsEarned: 5 };
  });
  mockApi.study.startSession.mockRejectedValue(new Error('새 세션 생성 실패'));
  const qc = client();
  await renderScreen(<HomeScreen />, qc);
  const nextStart = await screen.findByLabelText('새 공부 시작');
  await waitFor(() => expect(mockApi.study.weekly).toHaveBeenCalled());
  const initialDaily = mockApi.study.today.mock.calls.length;
  const initialWeekly = mockApi.study.weekly.mock.calls.length;
  await fireEvent.press(nextStart);
  expect(previousEnded).toBe(true);
  expect(mockApi.study.endSession).toHaveBeenCalledWith(
    'old-session',
    expect.objectContaining({ endReason: 'switch' }),
  );
  expect(mockApi.study.startSession).toHaveBeenCalledTimes(1);
  expect(useSession.getState()).toMatchObject({ itemId: null, sessionId: null, since: null });
  expect(mockToast).toHaveBeenCalled();
  await waitFor(() => {
    expect(mockApi.study.today.mock.calls.length).toBeGreaterThan(initialDaily);
    expect(mockApi.study.weekly.mock.calls.length).toBeGreaterThan(initialWeekly);
  });
  expect(await screen.findAllByText('00:00:12')).not.toHaveLength(0);
  expect(
    qc.getQueriesData<{ totalSec: number }>({ queryKey: ['study', 'weekly'] })[0]?.[1]?.totalSec,
  ).toBe(12);
});
