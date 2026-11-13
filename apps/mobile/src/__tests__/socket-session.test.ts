import { AppState } from 'react-native';
import { Buffer } from 'buffer';
import { connectSocket, disconnectSocket, socket } from '../lib/socket';
import { refreshAccessTokens } from '../lib/api/http';
import { useAuth } from '../stores/auth';

const mockHandlers = new Map<string, (...args: never[]) => void>();
const mockClient = {
  connected: false,
  active: true,
  on: jest.fn((event: string, callback: (...args: never[]) => void) => {
    mockHandlers.set(event, callback);
  }),
  off: jest.fn(),
  emit: jest.fn(),
  connect: jest.fn(() => {
    mockClient.connected = true;
    mockHandlers.get('connect')?.();
  }),
  disconnect: jest.fn(() => {
    mockClient.connected = false;
    mockHandlers.get('disconnect')?.();
  }),
};
jest.mock('socket.io-client', () => ({ io: jest.fn(() => mockClient) }));
jest.mock('../lib/api/http', () => ({ refreshAccessTokens: jest.fn() }));
jest.mock('../lib/env', () => ({ env: { localData: false, socketUrl: 'http://localhost' } }));

const token = (exp: number) =>
  `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  jest.clearAllMocks();
  mockHandlers.clear();
  mockClient.connected = false;
  mockClient.active = true;
  jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove: jest.fn() });
  useAuth.setState({
    userId: 'user-a',
    tokens: { accessToken: token(Date.now() / 1000 + 60), refreshToken: 'refresh' },
  });
});
afterEach(() => {
  disconnectSocket();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('토큰 만료 전 갱신 후 소켓을 다시 연결해 방 복구를 알린다', async () => {
  const next = token(Date.now() / 1000 + 900);
  jest.mocked(refreshAccessTokens).mockImplementation(async () => {
    useAuth.setState({ tokens: { accessToken: next, refreshToken: 'new-refresh' } });
    return true;
  });
  const states = jest.fn();
  const stop = socket.onConnection(states);
  connectSocket();
  mockClient.connected = true;
  mockHandlers.get('connect')?.();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(refreshAccessTokens).toHaveBeenCalledTimes(1);
  expect(mockClient.disconnect).toHaveBeenCalledTimes(1);
  expect(mockClient.connect).toHaveBeenCalledTimes(1);
  expect(states.mock.calls.map(([connected]) => connected)).toEqual([true, false, true]);
  stop();
});

it('인증 오류 시 일시적인 갱신 실패를 재시도하고 새 토큰으로 연결한다', async () => {
  const next = token(Date.now() / 1000 + 900);
  jest
    .mocked(refreshAccessTokens)
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(async () => {
      useAuth.setState({ tokens: { accessToken: next, refreshToken: 'new-refresh' } });
      return true;
    });
  connectSocket();
  mockHandlers.get('connect_error')?.(new Error('unauthorized') as never);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(refreshAccessTokens).toHaveBeenCalledTimes(2);
  expect(mockClient.connect).toHaveBeenCalledTimes(1);
});

it('갱신 중 로그아웃하면 이전 계정의 소켓을 다시 열지 않는다', async () => {
  let finish!: (result: boolean) => void;
  jest.mocked(refreshAccessTokens).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  connectSocket();
  mockHandlers.get('connect_error')?.(new Error('unauthorized') as never);
  disconnectSocket();
  useAuth.setState({ userId: null, tokens: null });
  finish(true);
  await jest.advanceTimersByTimeAsync(0);
  expect(mockClient.connect).not.toHaveBeenCalled();
});

it('백그라운드에서 토큰이 만료된 뒤 복귀하면 즉시 갱신한다', async () => {
  const next = token(Date.now() / 1000 + 900);
  jest.mocked(refreshAccessTokens).mockImplementation(async () => {
    useAuth.setState({ tokens: { accessToken: next, refreshToken: 'new-refresh' } });
    return true;
  });
  connectSocket();
  jest.setSystemTime(Date.now() + 90_000);
  const listener = jest.mocked(AppState.addEventListener).mock.calls[0]?.[1];
  listener?.('active');
  await jest.advanceTimersByTimeAsync(0);
  expect(refreshAccessTokens).toHaveBeenCalledTimes(1);
  expect(mockClient.connect).toHaveBeenCalledTimes(1);
});
