import { renderHook } from '@testing-library/react-native';

import { useAiJobSubscription } from '../hooks';

const mockEmit = jest.fn();
const mockListeners = new Set<(connected: boolean) => void>();
jest.mock('../lib/socket', () => ({
  socket: {
    emit: (...args: unknown[]) => mockEmit(...args),
    on: () => () => {},
    onConnection: (fn: (connected: boolean) => void) => {
      mockListeners.add(fn);
      fn(true);
      return () => mockListeners.delete(fn);
    },
  },
}));

const reconnect = () => mockListeners.forEach((fn) => fn(true));
const subscribes = () => mockEmit.mock.calls.filter(([ev]) => ev === 'ai:subscribe');

beforeEach(() => {
  mockEmit.mockClear();
  mockListeners.clear();
});

describe('useAiJobSubscription (AI 작업 진행률 구독)', () => {
  it('작업이 생기면 구독하고, 없으면 보내지 않는다', async () => {
    const { rerender } = await renderHook(
      ({ id }: { id: string | null }) => useAiJobSubscription(id),
      { initialProps: { id: null } },
    );
    expect(mockEmit).not.toHaveBeenCalled();
    await rerender({ id: 'job1' });
    expect(subscribes()).toEqual([['ai:subscribe', { jobId: 'job1' }]]);
  });

  it('소켓이 다시 연결되면 다시 구독한다(서버 구독은 연결마다 따로)', async () => {
    await renderHook(() => useAiJobSubscription('job1'));
    reconnect();
    expect(subscribes()).toHaveLength(2);
  });

  it('같은 작업을 다시 시도하면(again이 바뀜) 다시 구독한다', async () => {
    const { rerender } = await renderHook(
      ({ again }: { again: number }) => useAiJobSubscription('job1', again),
      { initialProps: { again: 0 } },
    );
    await rerender({ again: 1 });
    expect(subscribes()).toHaveLength(2);
  });

  it('화면을 떠나면 구독을 끝내고, 그 뒤 다시 연결돼도 구독하지 않는다', async () => {
    const { unmount } = await renderHook(() => useAiJobSubscription('job1'));
    await unmount();
    expect(mockEmit).toHaveBeenLastCalledWith('ai:unsubscribe', { jobId: 'job1' });
    reconnect();
    expect(subscribes()).toHaveLength(1);
  });
});
