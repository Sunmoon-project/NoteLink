import { api } from '../lib/api';
import { useNet } from '../stores/net';
import { useSession } from '../stores/session';
import { useToast } from '../stores/toast';
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  const result = promise.then(
    (value) => {
      done = true;
      return { value };
    },
    (error) => {
      done = true;
      return { error };
    },
  );
  await Promise.resolve();
  for (let tick = 0; !done && tick < 100; tick++) await jest.advanceTimersToNextTimerAsync();
  if (!done) throw new Error('요청이 완료되지 않았습니다');
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-02T00:00:00Z'));
  useNet.setState({ state: 'ok' });
  useSession.getState().reset();
});
afterEach(() => {
  useSession.getState().reset();
  useNet.setState({ state: 'ok' });
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
async function start() {
  const item = await settle(
    api.study.addItem({ title: '서버와 일치', subjectName: '수학', goalMin: null }),
  );
  await settle(useSession.getState().start(item._id));
  return item;
}
it('오프라인 재개 실패는 휴식을 유지하고 서버 정산과 같은 시간을 표시한다', async () => {
  const item = await start();
  jest.advanceTimersByTime(10000);
  await settle(Promise.resolve(useSession.getState().pause()));
  const pausedAt = useSession.getState().pausedAt;
  useNet.setState({ state: 'offline' });
  await settle(Promise.resolve(useSession.getState().resume()));
  expect(useSession.getState()).toMatchObject({ since: null, pausedAt });
  expect(useToast.getState().msg).toMatch(/재개.*못/);
  jest.advanceTimersByTime(60000);
  expect(useSession.getState().elapsed()).toBe(10);
  useNet.setState({ state: 'ok' });
  expect(await settle(useSession.getState().end('manual'))).toEqual({ sec: 10, pointsEarned: 0 });
  expect(
    (await settle(api.study.today())).items.find((x) => x._id === item._id)?.accumulatedSec,
  ).toBe(10);
});
it('오프라인 정지 실패는 측정을 유지하고 서버 정산과 같은 시간을 표시한다', async () => {
  await start();
  const since = useSession.getState().since;
  jest.advanceTimersByTime(10000);
  useNet.setState({ state: 'offline' });
  await settle(Promise.resolve(useSession.getState().pause()));
  expect(useSession.getState()).toMatchObject({ since, pausedAt: null });
  expect(useToast.getState().msg).toMatch(/정지.*못/);
  jest.advanceTimersByTime(60000);
  expect(useSession.getState().elapsed()).toBe(70);
  useNet.setState({ state: 'ok' });
  expect(await settle(useSession.getState().end('manual'))).toEqual({ sec: 70, pointsEarned: 0 });
});
it('정지·재개 중복 클릭은 서버 요청을 한 번만 보내며 완료 전 표시를 바꾸지 않는다', async () => {
  await start();
  const pause = jest.spyOn(api.study, 'pauseSession');
  const resume = jest.spyOn(api.study, 'resumeSession');
  const first = Promise.resolve(useSession.getState().pause());
  const second = Promise.resolve(useSession.getState().pause());
  expect(useSession.getState().pausedAt).toBeNull();
  await settle(Promise.all([first, second]));
  expect(pause).toHaveBeenCalledTimes(1);
  expect(useSession.getState().since).toBeNull();
  const a = Promise.resolve(useSession.getState().resume());
  const b = Promise.resolve(useSession.getState().resume());
  expect(useSession.getState().since).toBeNull();
  await settle(Promise.all([a, b]));
  expect(resume).toHaveBeenCalledTimes(1);
  expect(useSession.getState().pausedAt).toBeNull();
});
it('늦은 정지 응답은 초기화 뒤 새 측정을 정지시키지 않는다', async () => {
  await start();
  const pending = Promise.resolve(useSession.getState().pause());
  useSession.getState().reset();
  const next = await settle(
    api.study.addItem({ title: '새 측정', subjectName: '영어', goalMin: null }),
  );
  await settle(useSession.getState().start(next._id));
  await pending;
  expect(useSession.getState()).toMatchObject({ itemId: next._id, pausedAt: null });
  expect(useSession.getState().since).not.toBeNull();
});
it('정지 확인 대기 중 종료는 정지가 확정된 뒤 같은 세션을 정산한다', async () => {
  await start();
  jest.advanceTimersByTime(10000);
  const paused = Promise.resolve(useSession.getState().pause());
  const ended = useSession.getState().end('manual');
  const result = await settle(Promise.all([paused, ended]));
  expect(result[1]).toEqual({ sec: 10, pointsEarned: 0 });
  expect(useSession.getState().sessionId).toBeNull();
});
it('여러 짧은 측정 구간의 소수 초도 누적해 서버와 같은 정수 초를 표시한다', async () => {
  await start();
  for (let index = 0; index < 3; index++) {
    jest.advanceTimersByTime(600);
    await settle(Promise.resolve(useSession.getState().pause()));
    if (index < 2) await settle(Promise.resolve(useSession.getState().resume()));
  }
  expect(useSession.getState().elapsed()).toBe(1);
  expect(await settle(useSession.getState().end('manual'))).toEqual({ sec: 1, pointsEarned: 0 });
});

it('자동 종료 대기 중 재개가 확정되면 새로 재개한 측정을 종료하지 않는다', async () => {
  await start();
  await settle(useSession.getState().pause());
  jest.advanceTimersByTime(600001);
  const end = jest.spyOn(api.study, 'endSession');
  const resumed = Promise.resolve(useSession.getState().resume());
  const automatic = useSession.getState().end('auto_pause_timeout');
  await settle(Promise.all([resumed, automatic]));
  expect(end).not.toHaveBeenCalled();
  expect(useSession.getState().sessionId).not.toBeNull();
  expect(useSession.getState().since).not.toBeNull();
  expect(useSession.getState().pausedAt).toBeNull();
});

it('정지 확인 대기 중 재개를 요청하면 확인 뒤 다시 재개한다', async () => {
  await start();
  const resume = jest.spyOn(api.study, 'resumeSession');
  const paused = useSession.getState().pause();
  const resumed = useSession.getState().resume();
  await settle(Promise.all([paused, resumed]));
  expect(resume).toHaveBeenCalledTimes(1);
  expect(useSession.getState().pausedAt).toBeNull();
  expect(useSession.getState().since).not.toBeNull();
});
it('가로 재개 확인 대기 중 세로 정지를 요청하면 최종 정지 상태를 유지한다', async () => {
  await start();
  await settle(useSession.getState().pause());
  const pause = jest.spyOn(api.study, 'pauseSession');
  const resumed = useSession.getState().resume();
  const paused = useSession.getState().pause();
  await settle(Promise.all([resumed, paused]));
  expect(pause).toHaveBeenCalledTimes(1);
  expect(useSession.getState().since).toBeNull();
  expect(useSession.getState().pausedAt).not.toBeNull();
});
it('정지→재개→정지의 빠른 입력은 마지막 의도로 합치고 불필요한 재개를 보내지 않는다', async () => {
  await start();
  const pause = jest.spyOn(api.study, 'pauseSession');
  const resume = jest.spyOn(api.study, 'resumeSession');
  const a = useSession.getState().pause();
  const b = useSession.getState().resume();
  const c = useSession.getState().pause();
  await settle(Promise.all([a, b, c]));
  expect(pause).toHaveBeenCalledTimes(1);
  expect(resume).not.toHaveBeenCalled();
  expect(useSession.getState().since).toBeNull();
});

it('재개로 취소된 자동 종료를 기다리던 항목 전환도 이전 세션을 실제 정산한다', async () => {
  await start();
  const previousId = useSession.getState().sessionId;
  const next = await settle(
    api.study.addItem({ title: '전환 후 항목', subjectName: '영어', goalMin: null }),
  );
  jest.advanceTimersByTime(10000);
  await settle(useSession.getState().pause());
  jest.advanceTimersByTime(600001);
  const finish = jest.spyOn(api.study, 'endSession');
  const resumed = useSession.getState().resume();
  const automatic = useSession.getState().end('auto_pause_timeout');
  const switched = useSession.getState().start(next._id);
  await settle(Promise.all([resumed, automatic, switched]));
  expect(finish).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledWith(previousId, expect.objectContaining({ endReason: 'switch' }));
  expect(useSession.getState().itemId).toBe(next._id);
  expect(useSession.getState().sessionId).not.toBe(previousId);
});
it('재개로 자동 종료가 취소돼도 같이 요청한 수동 종료는 처리한다', async () => {
  await start();
  jest.advanceTimersByTime(10000);
  await settle(useSession.getState().pause());
  jest.advanceTimersByTime(600001);
  const finish = jest.spyOn(api.study, 'endSession');
  const resumed = useSession.getState().resume();
  const automatic = useSession.getState().end('auto_pause_timeout');
  const manual = useSession.getState().end('manual');
  const result = await settle(Promise.all([resumed, automatic, manual]));
  expect(finish).toHaveBeenCalledTimes(1);
  expect(result[2]).toMatchObject({ sec: 10 });
  expect(useSession.getState().sessionId).toBeNull();
});
