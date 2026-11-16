import { screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { ChatScreen } from '../features/social/screens';
import { renderScreen, setParams } from '../test-utils';

const mockApi = { social: { openDirect: jest.fn(), messages: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
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
afterEach(() => {
  jest.clearAllMocks();
  mockHandlers.clear();
});

it('방을 나간 동안 받은 메시지도 30초 이내 재입장하면 기록에서 갱신한다', async () => {
  const old = {
    _id: 'old',
    chatRoomId: 'room-1',
    senderId: 'friend-1',
    text: '나가기 전 기록',
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  const incoming = { ...old, _id: 'offscreen', text: '나간 동안 도착한 말' };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30000 } } });
  setParams({ id: 'friend-1', name: '친구' });
  mockApi.social.openDirect.mockResolvedValue({ _id: 'room-1' });
  mockApi.social.messages.mockResolvedValueOnce([old]).mockResolvedValueOnce([old, incoming]);
  try {
    const first = await renderScreen(<ChatScreen />, qc);
    expect(await screen.findByText(old.text)).toBeTruthy();
    await first.unmount();
    expect(mockHandlers.has('chat:message')).toBe(false);
    // 화면 밖에는 구독이 없으므로 서버 기록에만 새 메시지가 있다.
    await renderScreen(<ChatScreen />, qc);
    expect(await screen.findByText(incoming.text)).toBeTruthy();
    expect(screen.getByText(old.text)).toBeTruthy();
    await waitFor(() => expect(mockApi.social.messages).toHaveBeenCalledTimes(2));
  } finally {
    qc.clear();
  }
});
