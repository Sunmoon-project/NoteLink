import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { ChatScreen, FriendAddScreen } from '../features/social/screens';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

const mockApi = {
  social: {
    openDirect: jest.fn(),
    messages: jest.fn(),
    remove: jest.fn(),
    search: jest.fn(),
    sendRequest: jest.fn(),
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
jest.mock('../lib/socket', () => ({ socket: { on: jest.fn(() => () => {}), emit: jest.fn() } }));
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30000, gcTime: Infinity } },
  });
  clients.push(qc);
  return qc;
}
beforeEach(() => {
  jest.clearAllMocks();
  useToast.setState({ msg: null });
  setParams({ id: 'friend-1', name: '친구' });
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
});

it('친구 삭제 후 즉시 다시 입장해도 이전 DM 캐시와 삭제된 대화가 복원되지 않는다', async () => {
  let deleted = false;
  const old = {
    _id: 'old-message',
    chatRoomId: 'old-room',
    senderId: 'friend-1',
    text: '삭제 전 비공개 대화',
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  mockApi.social.openDirect.mockImplementation(async () => ({
    _id: deleted ? 'new-room' : 'old-room',
  }));
  mockApi.social.messages.mockImplementation(async () => (deleted ? [] : [old]));
  mockApi.social.remove.mockImplementation(async () => {
    deleted = true;
  });
  const qc = client();
  const first = await renderScreen(<ChatScreen />, qc);
  expect(await screen.findByText(old.text)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('더보기'));
  await fireEvent.press(screen.getByText('친구 삭제'));
  await fireEvent.press(screen.getByText('삭제'));
  await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
  expect(mockApi.social.remove).toHaveBeenCalledWith('friend-1');
  await first.unmount();
  await renderScreen(<ChatScreen />, qc);
  await waitFor(() => expect(mockApi.social.openDirect.mock.calls.length).toBeGreaterThan(1));
  await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledWith('new-room'));
  await waitFor(() => expect(qc.getQueryState(['messages', 'new-room'])?.fetchStatus).toBe('idle'));
  expect(screen.queryByText(old.text)).toBeNull();
  expect(qc.getQueryData(['messages', 'old-room'])).toBeUndefined();
});

it('친구 요청 실패를 안내하고 같은 사용자에게 재시도하면 성공 상태로 바뀐다', async () => {
  const user = { userId: 'friend-2', nickname: '재시도할 친구', handle: '@retry', mutualCount: 0 };
  mockApi.social.search.mockResolvedValue([user]);
  mockApi.social.sendRequest
    .mockRejectedValueOnce(new Error('네트워크 오류'))
    .mockResolvedValueOnce(undefined);
  await renderScreen(<FriendAddScreen />, client());
  await fireEvent.changeText(screen.getByPlaceholderText('닉네임을 입력해주세요.'), user.nickname);
  await fireEvent.press(await screen.findByText('친구 요청 보내기'));
  await waitFor(() => expect(mockApi.social.sendRequest).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(useToast.getState().msg).toBeTruthy());
  expect(screen.queryByText('요청 보냄')).toBeNull();
  const retry = screen.getByRole('button', { name: '친구 요청 보내기' });
  expect(retry).toBeEnabled();
  await fireEvent.press(retry);
  expect(await screen.findByText('요청 보냄')).toBeTruthy();
  expect(mockApi.social.sendRequest).toHaveBeenCalledTimes(2);
  expect(mockApi.social.sendRequest).toHaveBeenNthCalledWith(1, user.userId);
  expect(mockApi.social.sendRequest).toHaveBeenNthCalledWith(2, user.userId);
});
