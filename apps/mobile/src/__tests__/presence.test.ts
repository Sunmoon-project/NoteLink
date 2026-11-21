import { AppState } from 'react-native';
import { api } from '@/lib/api';
import { leavePresence, PRESENCE_MS, startPresence } from '@/lib/presence';

// 실기기 피드백: 앱을 나가도 친구에게 '활동 중'으로 보였다 → 앞에 있는 동안만 신호를 보내고, 나가면 거둔다
jest.mock('@/lib/api', () => ({ api: { me: { presence: jest.fn() } } }));
jest.mock('@/lib/env', () => ({ env: { localData: false } }));

const presence = jest.mocked(api.me.presence);
const remove = jest.fn();
let listeners: ((state: string) => void)[] = [];
const goTo = (state: string) => listeners.forEach((fn) => fn(state));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  listeners = [];
  presence.mockResolvedValue(undefined);
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _: string,
    fn: (state: string) => void,
  ) => {
    listeners.push(fn);
    return { remove };
  }) as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('앞에 있으면 바로 · 그 뒤 1분마다 신호를 보내고, 백그라운드로 가면 거두고 멈춘다', async () => {
  const stop = startPresence();
  expect(presence).toHaveBeenLastCalledWith(true, expect.any(String));
  await jest.advanceTimersByTimeAsync(PRESENCE_MS);
  expect(presence).toHaveBeenCalledTimes(2);

  goTo('background');
  expect(presence).toHaveBeenLastCalledWith(false, expect.any(String));
  await jest.advanceTimersByTimeAsync(PRESENCE_MS * 3);
  expect(presence).toHaveBeenCalledTimes(3);

  goTo('active');
  expect(presence).toHaveBeenLastCalledWith(true, expect.any(String));
  stop();
  expect(remove).toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(PRESENCE_MS * 3);
  expect(presence).toHaveBeenCalledTimes(4);
});

it('백그라운드에서 시작하면 앞에 나올 때까지 보내지 않고, 실패해도 멈추지 않는다', async () => {
  Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
  presence.mockRejectedValue(new Error('offline'));
  const stop = startPresence();
  expect(presence).not.toHaveBeenCalled();
  goTo('active');
  await jest.advanceTimersByTimeAsync(PRESENCE_MS);
  expect(presence).toHaveBeenCalledTimes(2);
  stop();
});

it('로그아웃(leavePresence)은 타이머를 먼저 멈추고 신호를 거둬, 뒤에 신호가 다시 가지 않는다', async () => {
  startPresence();
  expect(presence).toHaveBeenLastCalledWith(true, expect.any(String));
  await leavePresence();
  expect(presence).toHaveBeenLastCalledWith(false, expect.any(String));
  expect(remove).toHaveBeenCalled();
  const calls = presence.mock.calls.length;
  await jest.advanceTimersByTimeAsync(PRESENCE_MS * 3);
  expect(presence).toHaveBeenCalledTimes(calls);
});
