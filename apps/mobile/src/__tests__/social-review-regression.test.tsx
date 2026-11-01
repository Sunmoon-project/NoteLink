import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ChatScreen, RequestsScreen } from '../features/social/screens';
import { SocialDrawer } from '../features/social/drawer';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  me: { get: jest.fn(), setStatus: jest.fn() },
  social: {
    openDirect: jest.fn(),
    messages: jest.fn(),
    received: jest.fn(),
    friends: jest.fn(),
    respond: jest.fn(),
    remove: jest.fn(),
  },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
const mockHandlers = new Map<string, (message: unknown) => void>();
jest.mock('../lib/socket', () => ({
  socket: {
    on: (event: string, handler: (message: unknown) => void) => {
      mockHandlers.set(event, handler);
      return () => mockHandlers.delete(event);
    },
    emit: jest.fn(),
  },
}));

const request = {
  _id: 'request-1',
  requester: { userId: 'friend-1', nickname: '친구', handle: '@friend' },
  requestedAt: '2026-10-30T00:00:00.000Z',
};
const message = {
  _id: 'live-1',
  chatRoomId: 'room-1',
  senderId: 'friend-1',
  text: '조회 도중 받은 새 메시지',
  createdAt: '2026-10-31T00:01:00.000Z',
};
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30000 } } });
  clients.push(qc);
  return qc;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
  useToast.setState({ msg: null });
  setParams({ id: 'friend-1', name: '친구' });
  mockApi.social.openDirect.mockResolvedValue({ _id: 'room-1' });
  mockApi.social.messages.mockResolvedValue([]);
  mockApi.social.received.mockResolvedValue([request]);
  mockApi.social.friends.mockResolvedValue([]);
  mockApi.social.respond.mockResolvedValue(undefined);
  mockApi.social.remove.mockResolvedValue(undefined);
  mockApi.me.get.mockResolvedValue({ nickname: '내 이름', status: 'active' });
  mockApi.me.setStatus.mockResolvedValue(undefined);
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
});

describe('PR33 채팅 기록과 실시간 메시지', () => {
  it('느린 기록 조회가 먼저 받은 소켓 메시지를 지우지 않는다', async () => {
    const history = deferred<unknown[]>();
    mockApi.social.messages.mockReturnValue(history.promise);
    await renderScreen(<ChatScreen />, client());
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledWith('room-1'));
    await act(async () => {
      mockHandlers.get('chat:message')!(message);
    });
    await waitFor(() => expect(screen.getByText(message.text)).toBeTruthy());
    await act(async () => {
      history.resolve([
        {
          ...message,
          _id: 'history-1',
          text: '먼저 보낸 기록',
          createdAt: '2026-10-31T00:00:00.000Z',
        },
      ]);
    });
    expect(await screen.findByText('먼저 보낸 기록')).toBeTruthy();
    expect(screen.getByText(message.text)).toBeTruthy();
  });

  it('캐시가 유효한 동안 채팅방에 다시 들어와도 새 메시지가 남는다', async () => {
    const qc = client();
    const first = await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledTimes(1));
    await act(async () => {});
    await act(async () => {
      mockHandlers.get('chat:message')!(message);
    });
    await waitFor(() => expect(screen.getByText(message.text)).toBeTruthy());
    await first.unmount();
    await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(screen.getByText(message.text)).toBeTruthy());
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledTimes(2));
  });
});

describe('PR33 친구 요청 수락과 거절', () => {
  it.each([
    ['수락', true],
    ['거절', false],
  ] as const)('%s 성공 시 요청과 친구 캐시를 갱신한다', async (label, ok) => {
    const qc = client();
    qc.setQueryData(['friends'], []);
    await renderScreen(<RequestsScreen />, qc);
    await fireEvent.press(await screen.findByText(label));
    await waitFor(() => expect(mockApi.social.respond).toHaveBeenCalledWith('request-1', ok));
    await waitFor(() => expect(qc.getQueryState(['friends'])?.isInvalidated).toBe(true));
    await waitFor(() => expect(mockApi.social.received).toHaveBeenCalledTimes(2));
  });

  it.each(['수락', '거절'])('%s 실패 시 요청을 유지하고 실패를 안내한다', async (label) => {
    mockApi.social.respond.mockRejectedValueOnce(new Error('저장 거절'));
    await renderScreen(<RequestsScreen />, client());
    await fireEvent.press(await screen.findByText(label));
    await waitFor(() => expect(mockApi.social.respond).toHaveBeenCalled());
    await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
    expect(screen.getByText('친구')).toBeTruthy();
    expect(mockApi.social.received).toHaveBeenCalledTimes(1);
  });
});

describe('PR33 내 상태 변경', () => {
  async function openStatus(qc: QueryClient) {
    await renderScreen(<SocialDrawer open onClose={jest.fn()} />, qc);
    await fireEvent.press(await screen.findByText('내 이름'));
    expect(screen.getByText('상태 변경')).toBeTruthy();
  }
  it('저장 성공 후 사용자 정보를 다시 조회하고 선택 창을 닫는다', async () => {
    await openStatus(client());
    mockApi.me.get.mockResolvedValue({ nickname: '내 이름', status: 'resting' });
    await fireEvent.press(screen.getByText('쉬는 중'));
    await waitFor(() => expect(mockApi.me.setStatus).toHaveBeenCalledWith('resting'));
    await waitFor(() => expect(mockApi.me.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('상태 변경')).toBeNull());
    expect(screen.getByText('쉬는 중')).toBeTruthy();
  });
  it('저장 실패 시 선택 창과 이전 상태를 유지하고 실패를 안내한다', async () => {
    mockApi.me.setStatus.mockRejectedValueOnce(new Error('저장 거절'));
    await openStatus(client());
    await fireEvent.press(screen.getByText('쉬는 중'));
    await waitFor(() => expect(mockApi.me.setStatus).toHaveBeenCalled());
    await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
    expect(screen.getByText('상태 변경')).toBeTruthy();
    expect(mockApi.me.get).toHaveBeenCalledTimes(1);
  });
});

describe('PR33 친구 삭제', () => {
  async function openDelete(qc: QueryClient) {
    await renderScreen(<ChatScreen />, qc);
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalled());
    await fireEvent.press(screen.getByLabelText('더보기'));
    await fireEvent.press(screen.getByText('친구 삭제'));
  }
  it('삭제 성공 후 친구 캐시를 갱신하고 방을 닫는다', async () => {
    const qc = client();
    qc.setQueryData(['friends'], [{ userId: 'friend-1' }]);
    await openDelete(qc);
    await fireEvent.press(screen.getByText('삭제'));
    await waitFor(() => expect(mockApi.social.remove).toHaveBeenCalledWith('friend-1'));
    await waitFor(() => expect(qc.getQueryState(['friends'])?.isInvalidated).toBe(true));
    expect(router.back).toHaveBeenCalledTimes(1);
  });
  it('삭제 실패 시 친구와 대화방을 유지하고 실패를 안내한다', async () => {
    mockApi.social.remove.mockRejectedValueOnce(new Error('삭제 거절'));
    const qc = client();
    qc.setQueryData(['friends'], [{ userId: 'friend-1' }]);
    await openDelete(qc);
    await fireEvent.press(screen.getByText('삭제'));
    await waitFor(() => expect(mockApi.social.remove).toHaveBeenCalled());
    await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
    expect(router.back).not.toHaveBeenCalled();
    expect(qc.getQueryState(['friends'])?.isInvalidated).toBe(false);
    expect(screen.getByText('친구님을 친구에서 삭제할까요?')).toBeTruthy();
  });
});

it('잘못된 외부 status 파라미터도 채팅 화면을 깨뜨리지 않는다', async () => {
  setParams({ id: 'friend-1', status: 'invalid' });
  await renderScreen(<ChatScreen />, client());
  expect(await screen.findByText('오프라인')).toBeTruthy();
});
