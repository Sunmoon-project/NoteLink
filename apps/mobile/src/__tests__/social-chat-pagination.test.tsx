import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { FlatList } from 'react-native';
import { ChatScreen } from '../features/social/screens';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  rooms: { join: jest.fn() },
  social: {
    openDirect: jest.fn(),
    messages: jest.fn(),
  },
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

const scrollToTop = async () => {
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
};

describe('1:1 채팅 이전 기록 페이지', () => {
  beforeEach(() => {
    setParams({ id: 'u1', name: '지우' });
    mockApi.social.openDirect.mockReset().mockResolvedValue({ _id: 'room1' });
    mockApi.social.messages.mockReset();
    mockEmit.mockReset();
    mockSocketHandlers.clear();
  });

  it('병합된 캐시가 있어도 서버 페이지 커서로 중간 기록을 빠짐없이 불러온다', async () => {
    const latest = Array.from({ length: 50 }, (_, index) => directMessage(index + 71));
    const middle = Array.from({ length: 50 }, (_, index) => directMessage(index + 21));
    const oldest = Array.from({ length: 20 }, (_, index) => directMessage(index + 1));
    mockApi.social.messages.mockImplementation(async (_roomId: string, before?: string) => {
      if (!before) return latest;
      if (before === 'message-71') return middle;
      if (before === 'message-21') return oldest;
      return [];
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['messages', 'room1'], { messages: oldest, hasMore: true, nextBefore: 'message-1' });

    const view = await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledWith('room1'));
    await scrollToTop();
    await waitFor(() =>
      expect(mockApi.social.messages).toHaveBeenNthCalledWith(2, 'room1', 'message-71'),
    );
    await waitFor(() =>
      expect(qc.getQueryData<{ messages: unknown[] }>(['messages', 'room1'])?.messages).toHaveLength(120),
    );

    await scrollToTop();
    await waitFor(() =>
      expect(mockApi.social.messages).toHaveBeenNthCalledWith(3, 'room1', 'message-21'),
    );
    await waitFor(() =>
      expect(qc.getQueryData<{ messages: unknown[] }>(['messages', 'room1'])?.messages).toHaveLength(120),
    );
    view.unmount();
    qc.clear();
  });

  it('이전 페이지 요청에 실패하면 다시 시도해 페이지를 이어서 가져온다', async () => {
    const latest = Array.from({ length: 50 }, (_, index) => directMessage(index + 51));
    const older = Array.from({ length: 50 }, (_, index) => directMessage(index + 1));
    mockApi.social.messages
      .mockResolvedValueOnce(latest)
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(older);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view = await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledWith('room1'));
    await scrollToTop();
    await waitFor(() => expect(screen.getByText('이전 대화를 불러오지 못했어요 · 다시 시도')));
    expect(mockApi.social.messages).toHaveBeenNthCalledWith(2, 'room1', 'message-51');

    await fireEvent.press(screen.getByText('이전 대화를 불러오지 못했어요 · 다시 시도'));
    await waitFor(() =>
      expect(mockApi.social.messages).toHaveBeenNthCalledWith(3, 'room1', 'message-51'),
    );
    await waitFor(() => expect(screen.getByText('message body 1')));
    view.unmount();
    qc.clear();
  });

  it('이전 페이지를 앞에 붙인 뒤 기존 화면 위치만큼 스크롤 오프셋을 보정한다', async () => {
    const latest = Array.from({ length: 50 }, (_, index) => directMessage(index + 51));
    const older = Array.from({ length: 50 }, (_, index) => directMessage(index + 1));
    mockApi.social.messages.mockResolvedValueOnce(latest).mockResolvedValueOnce(older);
    const scrollSpy = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const view = await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledWith('room1'));
    const list = screen.getByTestId('direct-chat-messages');
    act(() => {
      list.props.onLayout?.({ nativeEvent: { layout: { height: 600 } } });
      list.props.onContentSizeChange?.(390, 2400);
    });
    scrollSpy.mockClear();
    await act(async () =>
      list.props.onScroll?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 32 },
          contentSize: { width: 390, height: 2400 },
          layoutMeasurement: { width: 390, height: 600 },
        },
      }),
    );
    await waitFor(() =>
      expect(mockApi.social.messages).toHaveBeenNthCalledWith(2, 'room1', 'message-51'),
    );
    const updatedList = screen.getByTestId('direct-chat-messages');
    const onContentSizeChange = updatedList.props.onContentSizeChange as
      | ((width: number, height: number) => void)
      | undefined;
    expect(onContentSizeChange).toEqual(expect.any(Function));
    act(() => onContentSizeChange?.(390, 3600));
    await waitFor(() =>
      expect(scrollSpy).toHaveBeenCalledWith({ offset: expect.any(Number), animated: false }),
    );
    expect(scrollSpy.mock.calls[0]?.[0].offset).toBeGreaterThan(32);
    scrollSpy.mockRestore();
    view.unmount();
    qc.clear();
  });
});
