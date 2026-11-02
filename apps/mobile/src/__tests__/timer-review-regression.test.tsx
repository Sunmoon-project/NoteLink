import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Accelerometer } from 'expo-sensors';
import { api } from '../lib/api';
import { HomeScreen } from '../features/session/home';
import { WeekGoalSheet } from '../features/session/sheets';
import { LandscapeScreen, SummaryScreen } from '../features/session/summary';
import { useToast } from '../stores/toast';
import { useSession } from '../stores/session';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-sensors', () => ({
  Accelerometer: { addListener: jest.fn(() => ({ remove() {} })), setUpdateInterval: jest.fn() },
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('expo-screen-orientation', () => ({
  lockAsync: jest.fn(async () => {}),
  OrientationLock: { LANDSCAPE: 'landscape', PORTRAIT_UP: 'portrait' },
}));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: {},
}));

let mockNow = Date.parse('2026-10-31T14:59:59Z');
jest.mock('../hooks', () => ({ ...jest.requireActual('../hooks'), useNow: () => mockNow }));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual<typeof import('react')>('react').useEffect(callback, [callback]),
}));
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  useSession.getState().reset();
});
it('일시정지해도 가로 전환 센서가 살아 있다', async () => {
  useSession.setState({ itemId: 'item', since: null, pausedAt: mockNow });
  await renderScreen(<HomeScreen />, client());
  await waitFor(() => expect(Accelerometer.addListener).toHaveBeenCalled());
  const listener = jest.mocked(Accelerometer.addListener).mock.calls[0]![0];
  await act(async () => listener({ x: 1, y: 0, z: 0, timestamp: 0 }));
  expect(router.push).toHaveBeenCalledWith('/landscape');
});
it('서울 날짜가 바뀌면 같은 화면에서 오늘과 주간 목표를 새로 읽는다', async () => {
  const today = jest.spyOn(api.study, 'today');
  const weekly = jest.spyOn(api.study, 'weekly');
  const goal = jest.spyOn(api.study, 'weeklyGoal');
  mockNow = Date.parse('2026-10-31T14:59:59Z');
  await renderScreen(<HomeScreen />, client());
  await waitFor(() => expect(goal).toHaveBeenCalled());
  const before = [today.mock.calls.length, weekly.mock.calls.length, goal.mock.calls.length];
  mockNow += 2000;
  await fireEvent.press(screen.getByLabelText('주간 목표 설정'));
  await waitFor(() => expect(today.mock.calls.length).toBeGreaterThan(before[0]!));
  expect(weekly.mock.calls.length).toBeGreaterThan(before[1]!);
  expect(goal.mock.calls.length).toBeGreaterThan(before[2]!);
});
it('직접 입력한 주간 목표를 실제 입력값으로 저장한다', async () => {
  const save = jest.spyOn(api.study, 'setWeeklyGoal');
  await renderScreen(<WeekGoalSheet open onClose={jest.fn()} />, client());
  await fireEvent.press(await screen.findByText('직접 입력'));
  await fireEvent.changeText(screen.getByPlaceholderText('목표 시간'), '32.5');
  await fireEvent.press(screen.getByText('저장하기'));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ targetMin: 1950 })),
  );
});
it('10분 쉬면 종료 요청을 한 번만 보낸다', async () => {
  mockNow = Date.now();
  useSession.setState({
    itemId: 'item',
    sessionId: 'auto-session',
    since: null,
    pausedAt: mockNow - 600001,
  });
  const end = jest
    .spyOn(api.study, 'endSession')
    .mockResolvedValue({ durationSec: 100, pointsEarned: 1 } as never);
  await renderScreen(<HomeScreen />, client());
  await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
});
it('닉네임을 자르거나 고정 스트릭을 표시하지 않는다', async () => {
  const me = await api.me.get();
  jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, nickname: '한결', streakDays: 3 });
  await api.study.addItem({ title: '테스트', subjectName: '수학', goalMin: 30 });
  await renderScreen(<HomeScreen />, client());
  expect(await screen.findByText(/한결 님/)).toBeTruthy();
  expect(screen.queryByText(/12일째/)).toBeNull();
});

it('세로로 세워 정지한 다음 다시 가로로 돌리면 측정을 재개한다', async () => {
  mockNow = Date.now();
  useSession.setState({
    itemId: 'item',
    sessionId: 'sensor-session',
    since: mockNow - 1000,
    pausedAt: null,
  });
  const firstLandscape = await renderScreen(<LandscapeScreen />, client());
  const portraitListener = jest.mocked(Accelerometer.addListener).mock.calls.at(-1)![0];
  await act(async () => portraitListener({ x: 0, y: 1, z: 0, timestamp: 0 }));
  await waitFor(() => expect(useSession.getState().since).toBeNull());
  expect(useSession.getState().pausedAt).not.toBeNull();
  expect(router.back).toHaveBeenCalledTimes(1);
  await firstLandscape.unmount();
  const home = await renderScreen(<HomeScreen />, client());
  const landscapeListener = jest.mocked(Accelerometer.addListener).mock.calls.at(-1)![0];
  await act(async () => landscapeListener({ x: 1, y: 0, z: 0, timestamp: 0 }));
  expect(router.push).toHaveBeenCalledWith('/landscape');
  await home.unmount();
  await renderScreen(<LandscapeScreen />, client());
  await waitFor(() => expect(useSession.getState().since).not.toBeNull());
  expect(useSession.getState().pausedAt).toBeNull();
});

it.each([
  [5400, '늘었어요'],
  [-5400, '줄었어요'],
] as const)(
  '종료 요약은 실제 닉네임과 전주 대비 %s초의 방향을 표시한다',
  async (diffFromLastWeekSec, direction) => {
    const me = await api.me.get();
    const weekly = await api.study.weekly();
    jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, nickname: '테스트 학습자' });
    jest.spyOn(api.study, 'weekly').mockResolvedValue({ ...weekly, diffFromLastWeekSec });
    await renderScreen(<SummaryScreen />, client());
    expect(await screen.findByText('수고했어요, 테스트 학습자 님')).toBeTruthy();
    expect(
      await screen.findByText(new RegExp(`지난주보다\\s+1시간 30분\\s+${direction}`)),
    ).toBeTruthy();
  },
);

it('홈은 전주보다 줄어든 시간을 양수와 감소 안내로 표시한다', async () => {
  const weekly = await api.study.weekly();
  jest.spyOn(api.study, 'weekly').mockResolvedValue({ ...weekly, diffFromLastWeekSec: -5400 });
  await api.study.addItem({ title: '감소 표시 확인', subjectName: '수학', goalMin: 30 });
  await renderScreen(<HomeScreen />, client());
  expect(await screen.findByText('지난주보다 1시간 30분 줄었어요')).toBeTruthy();
});

it('오늘 항목이 없어도 이번주 누적 기록을 표시한다', async () => {
  jest.spyOn(api.study, 'today').mockResolvedValue({ items: [], totalSec: 0 } as never);
  const weekly = await api.study.weekly();
  jest.spyOn(api.study, 'weekly').mockResolvedValue({ ...weekly, totalSec: 7200 });
  await renderScreen(<HomeScreen />, client());
  expect(await screen.findByText('2시간 0분')).toBeTruthy();
});
it('서울 자정 이후 목록에 없는 진행 중 세션도 종료할 수 있다', async () => {
  mockNow = Date.parse('2026-11-01T15:00:02Z');
  jest.spyOn(api.study, 'today').mockResolvedValue({ items: [], totalSec: 0 } as never);
  useSession.setState({ itemId: 'yesterday', sessionId: 'session', since: mockNow - 5000 });
  await renderScreen(<HomeScreen />, client());
  expect(await screen.findByText('종료')).toBeTruthy();
  expect(screen.getByText('00:00:02')).toBeTruthy();
});
it('목표 시트를 다시 열면 새 주 목표로 입력을 초기화한다', async () => {
  mockNow = Date.parse('2026-11-01T14:59:59Z');
  const goal = await api.study.weeklyGoal();
  jest
    .spyOn(api.study, 'weeklyGoal')
    .mockResolvedValue({ ...goal, targetMin: 600, notify80: false });
  const qc = client();
  let setOpen!: (v: boolean) => void;
  function Harness() {
    const [open, change] = useState(true);
    setOpen = change;
    return <WeekGoalSheet open={open} onClose={jest.fn()} />;
  }
  await renderScreen(<Harness />, qc);
  await screen.findByText('10시간');
  await act(async () => setOpen(false));
  jest
    .spyOn(api.study, 'weeklyGoal')
    .mockResolvedValue({ ...goal, targetMin: 1800, notify80: true });
  mockNow += 2000;
  await act(async () => setOpen(true));
  expect(await screen.findByText('30시간')).toBeTruthy();
});

it('종료 실패는 세션을 보존하고 다시 종료할 수 있다', async () => {
  mockNow = Date.now();
  useSession.setState({ itemId: 'item', sessionId: 'retry-session', since: mockNow - 5000 });
  const end = jest
    .spyOn(api.study, 'endSession')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ durationSec: 5, pointsEarned: 1 } as never);
  await expect(useSession.getState().end('manual')).rejects.toThrow('offline');
  expect(useSession.getState().sessionId).toBe('retry-session');
  await expect(useSession.getState().end('manual')).resolves.toEqual({ sec: 5, pointsEarned: 1 });
  expect(end).toHaveBeenCalledTimes(2);
  expect(useSession.getState().sessionId).toBeNull();
});
it('같은 날 목표 시트를 재열어도 새 조회 결과로 초기화한다', async () => {
  mockNow = Date.parse('2026-11-01T10:00:00Z');
  const original = await api.study.weeklyGoal();
  const query = jest
    .spyOn(api.study, 'weeklyGoal')
    .mockResolvedValue({ ...original, targetMin: 600 });
  let setOpen!: (v: boolean) => void;
  function Harness() {
    const [open, change] = useState(true);
    setOpen = change;
    return <WeekGoalSheet open={open} onClose={jest.fn()} />;
  }
  await renderScreen(<Harness />, client());
  await screen.findByText('10시간');
  await act(async () => setOpen(false));
  query.mockResolvedValue({ ...original, targetMin: 1800 });
  await act(async () => setOpen(true));
  expect(await screen.findByText('30시간')).toBeTruthy();
});
it('최초 목표 조회가 실패하면 오류와 재시도를 제공한다', async () => {
  const original = await api.study.weeklyGoal();
  jest
    .spyOn(api.study, 'weeklyGoal')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ ...original, targetMin: 900 });
  await renderScreen(<WeekGoalSheet open onClose={jest.fn()} />, client());
  await fireEvent.press(await screen.findByText('다시 시도'));
  expect(await screen.findByText('15시간')).toBeTruthy();
});
it('가로 타이머도 자정 이후 오늘 시간만 표시한다', async () => {
  mockNow = Date.parse('2026-11-01T15:00:02Z');
  jest.spyOn(api.study, 'today').mockResolvedValue({ items: [], totalSec: 0 } as never);
  useSession.setState({ itemId: 'item', sessionId: 'session', since: mockNow - 3602000 });
  await renderScreen(<LandscapeScreen />, client());
  expect(await screen.findByText('00:00:02')).toBeTruthy();
});

it('가로 화면도 재개 실패 시 측정 중으로 표시하지 않고 휴식을 유지한다', async () => {
  useSession.setState({
    itemId: 'paused-landscape',
    sessionId: 'paused-session',
    since: null,
    pausedAt: mockNow,
  });
  const resume = jest.spyOn(api.study, 'resumeSession').mockRejectedValue(new Error('offline'));
  await renderScreen(<LandscapeScreen />, client());
  await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useToast.getState().msg).toMatch(/재개.*못/));
  expect(screen.getByText('일시정지')).toBeTruthy();
  expect(screen.queryByText('자동 측정 중')).toBeNull();
  expect(useSession.getState().since).toBeNull();
});

it('세로 정지 응답이 늦어도 가로 재진입의 재개 의도를 이어서 적용한다', async () => {
  mockNow = Date.now();
  let confirmPause!: () => void;
  const pending = new Promise<void>((resolve) => {
    confirmPause = resolve;
  });
  const pause = jest.spyOn(api.study, 'pauseSession').mockReturnValueOnce(pending);
  const resume = jest.spyOn(api.study, 'resumeSession').mockResolvedValue(undefined);
  useSession.setState({
    itemId: 'fast-item',
    sessionId: 'fast-session',
    since: mockNow - 1000,
    pausedAt: null,
  });
  const first = await renderScreen(<LandscapeScreen />, client());
  const portrait = jest.mocked(Accelerometer.addListener).mock.calls.at(-1)![0];
  await act(async () => portrait({ x: 0, y: 1, z: 0, timestamp: 0 }));
  expect(pause).toHaveBeenCalledTimes(1);
  expect(useSession.getState().since).not.toBeNull();
  await first.unmount();
  await renderScreen(<LandscapeScreen />, client());
  await act(async () => confirmPause());
  await waitFor(() => expect(resume).toHaveBeenCalledWith('fast-session'));
  expect(useSession.getState().since).not.toBeNull();
  expect(useSession.getState().pausedAt).toBeNull();
  expect(screen.getByText('자동 측정 중')).toBeTruthy();
});
