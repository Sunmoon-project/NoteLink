import { act, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { ChatScreen } from '../features/social/screens';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { join: jest.fn() },
  social: { openDirect: jest.fn(), messages: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: jest.requireActual('../lib/api/http').ApiError,
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const mockEmit = jest.fn();
const mockSocketHandlers = new Map<string, (message: unknown) => void>();
jest.mock('../lib/socket', () => ({
  socket: {
    on: (event: string, handler: (message: unknown) => void) => {
      mockSocketHandlers.set(event, handler);
      return () => mockSocketHandlers.delete(event);
    },
    emit: (...args: unknown[]) => mockEmit(...args),
  },
}));

const directMessage = (n: number) => ({
  _id: `message-${n}`,
  chatRoomId: 'room1',
  senderId: 'u1',
  type: 'text' as const,
  text: `message body ${n}`,
  sharedItemId: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
});

describe('1:1 채팅 재접속 기록 페이지', () => {
  beforeEach(() => {
    setParams({ id: 'u1', name: '지우' });
    mockApi.social.openDirect.mockReset().mockResolvedValue({ _id: 'room1' });
    mockApi.social.messages.mockReset();
    mockEmit.mockReset();
    mockSocketHandlers.clear();
  });

  it('hasMore가 false여도 재접속 ACK 뒤 누락된 50개 중간 기록을 다시 조회한다', async () => {
    const latest = Array.from({ length: 50 }, (_, index) => directMessage(index + 71));
    const cachedOld = Array.from({ length: 20 }, (_, index) => directMessage(index + 1));
    const missingMiddle = Array.from({ length: 50 }, (_, index) => directMessage(index + 21));
    mockApi.social.messages.mockResolvedValueOnce([]).mockResolvedValueOnce(missingMiddle);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['messages', 'room1'], {
      messages: [...cachedOld, ...latest],
      hasMore: false,
    });

    const view = await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledWith('room1'));
    await waitFor(() =>
      expect(qc.getQueryState(['messages', 'room1'])?.fetchStatus).toBe('idle'),
    );
    const joinCall = mockEmit.mock.calls.find(([event]) => event === 'chat:join');
    const acknowledgeJoin = joinCall?.[2] as
      | ((result: { ok: boolean; missed: typeof latest }) => void)
      | undefined;
    expect(acknowledgeJoin).toEqual(expect.any(Function));
    await act(async () => {
      acknowledgeJoin?.({ ok: true, missed: latest });
    });

    await waitFor(() => {
      expect(qc.getQueryData<{ hasMore: boolean; nextBefore?: string }>([
        'messages',
        'room1',
      ])).toMatchObject({ hasMore: true, nextBefore: 'message-71' });
    });
    const list = screen.getByTestId('direct-chat-messages');
    await act(async () =>
      list.props.onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 390, height: 2400 },
          layoutMeasurement: { width: 390, height: 600 },
        },
      }),
    );
    await waitFor(() =>
      expect(mockApi.social.messages).toHaveBeenNthCalledWith(2, 'room1', 'message-71'),
    );
    await waitFor(() =>
      expect(qc.getQueryData<{ messages: unknown[] }>(['messages', 'room1'])?.messages).toHaveLength(
        120,
      ),
    );

    await act(async () => {
      view.unmount();
      qc.clear();
    });
  });

  it('재접속 ACK 이후 늦게 끝난 이전 페이지 응답은 새 커서를 덮지 않는다', async () => {
    const cached = Array.from({ length: 40 }, (_, index) => directMessage(index + 31));
    const latest = Array.from({ length: 50 }, (_, index) => directMessage(index + 71));
    let resolvePreviousPage!: (messages: ReturnType<typeof directMessage>[]) => void;
    const previousPage = new Promise<ReturnType<typeof directMessage>[]>((resolve) => {
      resolvePreviousPage = resolve;
    });
    mockApi.social.messages
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => previousPage);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['messages', 'room1'], {
      messages: cached,
      hasMore: true,
      nextBefore: 'message-31',
    });

    const view = await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledWith('room1'));
    await waitFor(() =>
      expect(qc.getQueryState(['messages', 'room1'])?.fetchStatus).toBe('idle'),
    );
    const list = screen.getByTestId('direct-chat-messages');
    await act(async () =>
      list.props.onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { width: 390, height: 2400 },
          layoutMeasurement: { width: 390, height: 600 },
        },
      }),
    );
    await waitFor(() =>
      expect(mockApi.social.messages).toHaveBeenNthCalledWith(2, 'room1', 'message-31'),
    );

    const joinCall = mockEmit.mock.calls.find(([event]) => event === 'chat:join');
    const acknowledgeJoin = joinCall?.[2] as
      | ((result: { ok: boolean; missed: typeof latest }) => void)
      | undefined;
    expect(acknowledgeJoin).toEqual(expect.any(Function));
    await act(async () => {
      acknowledgeJoin?.({ ok: true, missed: latest });
    });
    await waitFor(() =>
      expect(qc.getQueryData<{ hasMore: boolean; nextBefore?: string }>([
        'messages',
        'room1',
      ])).toMatchObject({ hasMore: true, nextBefore: 'message-71' }),
    );

    await act(async () => {
      resolvePreviousPage([]);
      await previousPage;
    });
    expect(qc.getQueryData<{ hasMore: boolean; nextBefore?: string }>([
      'messages',
      'room1',
    ])).toMatchObject({ hasMore: true, nextBefore: 'message-71' });

    await act(async () => {
      view.unmount();
      qc.clear();
    });
  });
});
