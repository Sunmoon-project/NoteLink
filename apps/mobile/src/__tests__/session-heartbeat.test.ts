import { AppState } from 'react-native';
import { api } from '@/lib/api';
import { HEARTBEAT_MS, useSession } from '@/stores/session';

jest.mock('@/lib/api', () => ({
  api: {
    study: {
      startSession: jest.fn(),
      pauseSession: jest.fn(),
      resumeSession: jest.fn(),
      endSession: jest.fn(),
      heartbeatSession: jest.fn(),
    },
  },
}));
jest.mock('@/stores/toast', () => ({ toast: jest.fn() }));

const study = jest.mocked(api.study);
const remove = jest.fn();
let listeners: ((state: string) => void)[] = [];

// 서버가 열어 준 세션이 있는 상태로 만든다
async function startSession(id = 's1') {
  study.startSession.mockResolvedValueOnce({ _id: id } as never);
  await useSession.getState().start('item1');
}

describe('공부 세션 하트비트', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    listeners = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      fn: (state: string) => void,
    ) => {
      listeners.push(fn);
      return { remove };
    }) as never);
    study.heartbeatSession.mockResolvedValue(undefined);
    study.pauseSession.mockResolvedValue(undefined);
    study.resumeSession.mockResolvedValue(undefined);
    study.endSession.mockResolvedValue({ durationSec: 60, pointsEarned: 0 } as never);
    useSession.getState().reset();
  });

  afterEach(() => {
    useSession.getState().reset();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('세션이 열려 있으면 60초마다 보낸다', async () => {
    await startSession();
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(study.heartbeatSession).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(study.heartbeatSession).toHaveBeenCalledTimes(1);
    expect(study.heartbeatSession).toHaveBeenLastCalledWith('s1');

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(study.heartbeatSession).toHaveBeenCalledTimes(2);
  });

  it('서버가 세션을 열어 주기 전(대기 상태)에는 보내지 않는다', async () => {
    let finish!: (s: { _id: string }) => void;
    study.startSession.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)) as never);
    const starting = useSession.getState().start('item1');

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(study.heartbeatSession).not.toHaveBeenCalled();

    finish({ _id: 's1' });
    await starting;
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(study.heartbeatSession).toHaveBeenCalledTimes(1);
  });

  it('일시정지 중에도 계속 보낸다', async () => {
    await startSession();
    await useSession.getState().pause();
    expect(useSession.getState().pausedAt).not.toBeNull();

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(study.heartbeatSession).toHaveBeenCalledTimes(1);
    expect(study.heartbeatSession).toHaveBeenLastCalledWith('s1');
  });

  it('앱이 다시 앞으로 오면(active) 바로 한 번 보내고, 다른 상태에서는 보내지 않는다', async () => {
    await startSession();
    expect(listeners).toHaveLength(1);

    listeners[0]!('background');
    listeners[0]!('inactive');
    expect(study.heartbeatSession).not.toHaveBeenCalled();

    listeners[0]!('active');
    expect(study.heartbeatSession).toHaveBeenCalledTimes(1);
    expect(study.heartbeatSession).toHaveBeenLastCalledWith('s1');
  });

  it('종료하면 타이머와 앱 상태 구독을 멈춘다', async () => {
    await startSession();
    await useSession.getState().end('manual');
    expect(useSession.getState().sessionId).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(study.heartbeatSession).not.toHaveBeenCalled();
  });

  it('로그아웃 · 계정 전환으로 초기화돼도 멈춘다', async () => {
    await startSession();
    useSession.getState().reset();
    expect(remove).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(study.heartbeatSession).not.toHaveBeenCalled();
  });

  it('앱 상태 구독이 없어도(addEventListener가 undefined) 시작 · 초기화가 오류 없이 되고 타이머는 정리된다', async () => {
    jest.spyOn(AppState, 'addEventListener').mockReturnValue(undefined as never);

    await startSession();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(study.heartbeatSession).toHaveBeenCalledTimes(1);

    expect(() => useSession.getState().reset()).not.toThrow();
    expect(useSession.getState().sessionId).toBeNull();
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(study.heartbeatSession).toHaveBeenCalledTimes(1);
  });

  it('구독을 풀다 오류가 나도 종료는 끝까지 되고 타이머는 정리된다', async () => {
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({
      remove: () => {
        throw new Error('remove 실패');
      },
    } as never);

    await startSession();
    await expect(useSession.getState().end('manual')).resolves.toMatchObject({ pointsEarned: 0 });
    expect(useSession.getState().sessionId).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('보내기에 실패해도 조용히 넘어가고 다음 신호를 이어 간다', async () => {
    study.heartbeatSession.mockRejectedValue(new Error('offline'));
    await startSession();

    await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(study.heartbeatSession).toHaveBeenCalledTimes(2);
    expect(useSession.getState().sessionId).toBe('s1');
  });
});
