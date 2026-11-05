import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { api } from '../lib/api';
import { HomeScreen } from '../features/session/home';
import { useSession } from '../stores/session';
import { useToast } from '../stores/toast';
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
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: {},
}));
const mockBlurs = new Set<() => void>();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (callback: () => (() => void) | void) =>
    jest.requireActual<typeof import('react')>('react').useEffect(() => {
      const blur = callback();
      if (blur) mockBlurs.add(blur);
      return blur;
    }, [callback]),
}));

const AUTO_MSG = '쉬는 시간이 길어져';
const summary = { pathname: '/summary', params: { sec: '100', points: '1' } };
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });
const blur = () => act(async () => mockBlurs.forEach((fn) => fn()));
const pausedAt = (msAgo: number) => ({
  itemId: 'item',
  sessionId: 'auto-session',
  since: null,
  pausedAt: Date.now() - msAgo,
});

let end: jest.SpyInstance;
beforeEach(() => {
  mockBlurs.clear();
  useToast.setState({ msg: null } as never);
  end = jest
    .spyOn(api.study, 'endSession')
    .mockResolvedValue({ durationSec: 100, pointsEarned: 1 } as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  useSession.getState().reset();
});

it('홈을 보는 중 자동 종료되면 요약 화면을 연다', async () => {
  useSession.setState(pausedAt(600_001));
  await renderScreen(<HomeScreen />, client());
  await waitFor(() => expect(router.push).toHaveBeenCalledWith(summary));
});

it('다른 화면을 보는 중 자동 종료되면 끌고 가지 않고 안내만 한다', async () => {
  useSession.setState(pausedAt(1000));
  await renderScreen(<HomeScreen />, client());
  await blur();
  await act(async () => useSession.setState(pausedAt(700_000)));
  await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useToast.getState().msg).toContain(AUTO_MSG));
  expect(router.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/summary' }));
});

it('직접 누른 종료는 응답 전에 화면을 옮겨도 요약을 열고 자동 종료 안내를 띄우지 않는다', async () => {
  useSession.setState(pausedAt(1000));
  let done!: (v: { durationSec: number; pointsEarned: number }) => void;
  end.mockReturnValue(new Promise((resolve) => (done = resolve)));
  await renderScreen(<HomeScreen />, client());
  const ending = fireEvent.press(await screen.findByText('종료'));
  await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
  await blur();
  await act(async () => done({ durationSec: 100, pointsEarned: 1 }));
  await ending;
  await waitFor(() => expect(router.push).toHaveBeenCalledWith(summary));
  expect(useToast.getState().msg ?? '').not.toContain(AUTO_MSG);
});
