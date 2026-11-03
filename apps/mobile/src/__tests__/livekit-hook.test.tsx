import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useLiveRoom } from '../lib/livekit';
import { useToast } from '../stores/toast';
import type { MediaConnection } from '../lib/livekit-native';

let mockUseMock = false;
const mockConnectMedia = jest.fn();
const mockEmit = jest.fn();
jest.mock('../lib/env', () => ({
  env: {
    get useMock() {
      return mockUseMock;
    },
  },
}));
jest.mock('../lib/socket', () => ({ socket: { emit: (...args: unknown[]) => mockEmit(...args) } }));
jest.mock('../lib/livekit-loader', () => ({
  loadMedia: async () => ({ connectMedia: (...args: unknown[]) => mockConnectMedia(...args) }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function media() {
  return {
    connected: true,
    micOn: false,
    camOn: false,
    hearing: true,
    toggleMic: jest.fn(async () => {}),
    toggleCam: jest.fn(async () => {}),
    toggleHearing: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    video: jest.fn(() => null),
  };
}
beforeEach(() => {
  mockUseMock = false;
  mockConnectMedia.mockReset();
  mockEmit.mockClear();
  useToast.setState({ msg: null });
});

it('목업에서는 가짜 미디어 연결·송출 상태를 만들지 않는다', async () => {
  mockUseMock = true;
  const { result } = await renderHook(() => useLiveRoom('room-1'));
  expect(result.current).toEqual(
    expect.objectContaining({ connected: false, micOn: false, camOn: false, hearing: false }),
  );
  await act(async () => {
    await result.current.toggleMic();
    await result.current.toggleCam();
    await result.current.toggleHearing();
  });
  expect(mockConnectMedia).not.toHaveBeenCalled();
  expect(mockEmit).not.toHaveBeenCalled();
  expect(useToast.getState().msg).toBeTruthy();
  expect(result.current.micOn).toBe(false);
});

it('실제 SDK 연결이 완료되어야 연결 상태를 표시하고 상태 변경을 반영한다', async () => {
  const pending = deferred<MediaConnection>();
  const connection = media();
  mockConnectMedia.mockReturnValue(pending.promise);
  const { result } = await renderHook(() => useLiveRoom('room-1'));
  expect(result.current.connected).toBe(false);
  await waitFor(() =>
    expect(mockConnectMedia).toHaveBeenCalledWith('room-1', expect.any(Function)),
  );
  await act(async () => pending.resolve(connection));
  await waitFor(() => expect(result.current.connected).toBe(true));
  expect(result.current.hearing).toBe(true);
  connection.micOn = true;
  connection.camOn = true;
  await act(async () => mockConnectMedia.mock.calls[0]![1]());
  expect(result.current.micOn).toBe(true);
  expect(result.current.camOn).toBe(true);
  expect(mockEmit).toHaveBeenLastCalledWith(
    'room:state',
    expect.objectContaining({ roomId: 'room-1', micOn: true, camOn: true }),
  );
});

it('마이크 토글을 연결 객체에 전달하고 실제 결과를 읽는다', async () => {
  const connection = media();
  connection.toggleMic.mockImplementation(async () => {
    connection.micOn = true;
  });
  mockConnectMedia.mockResolvedValue(connection);
  const { result } = await renderHook(() => useLiveRoom('room-1'));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await act(async () => {
    await result.current.toggleMic();
  });
  expect(connection.toggleMic).toHaveBeenCalledTimes(1);
  expect(result.current.micOn).toBe(true);
});

it.each(['toggleMic', 'toggleCam', 'toggleHearing'] as const)(
  '%s 실패는 상태를 위조하지 않고 안내한다',
  async (action) => {
    const connection = media();
    connection[action].mockRejectedValueOnce(new Error('권한 거절'));
    mockConnectMedia.mockResolvedValue(connection);
    const { result } = await renderHook(() => useLiveRoom('room-1'));
    await waitFor(() => expect(result.current.connected).toBe(true));
    await act(async () => {
      await result.current[action]();
    });
    expect(useToast.getState().msg).toBeTruthy();
    expect(result.current).toEqual(
      expect.objectContaining({ micOn: false, camOn: false, hearing: true }),
    );
  },
);

it('화면을 나가면 미디어 연결을 정리한다', async () => {
  const connection = media();
  mockConnectMedia.mockResolvedValue(connection);
  const { result, unmount } = await renderHook(() => useLiveRoom('room-1'));
  await waitFor(() => expect(result.current.connected).toBe(true));
  await unmount();
  expect(connection.close).toHaveBeenCalledTimes(1);
});

it('화면을 나간 뒤 늦게 완료된 연결도 즉시 정리한다', async () => {
  const pending = deferred<MediaConnection>();
  const connection = media();
  mockConnectMedia.mockReturnValue(pending.promise);
  const { unmount } = await renderHook(() => useLiveRoom('room-1'));
  await waitFor(() => expect(mockConnectMedia).toHaveBeenCalled());
  await unmount();
  await act(async () => pending.resolve(connection));
  await waitFor(() => expect(connection.close).toHaveBeenCalledTimes(1));
  expect(mockEmit).not.toHaveBeenCalled();
});

it('연결 실패는 연결되지 않은 상태와 복구 안내로 남긴다', async () => {
  mockConnectMedia.mockRejectedValueOnce(new Error('접속 실패'));
  const { result } = await renderHook(() => useLiveRoom('room-1'));
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current).toEqual(
    expect.objectContaining({ connected: false, micOn: false, camOn: false, hearing: false }),
  );
});

it('다른 방을 연결하는 동안 이전 방의 연결·송출 상태를 표시하지 않는다', async () => {
  const first = media();
  const next = deferred<MediaConnection>();
  mockConnectMedia.mockResolvedValueOnce(first).mockReturnValueOnce(next.promise);
  const { result, rerender } = await renderHook(({ id }: { id: string }) => useLiveRoom(id), {
    initialProps: { id: 'room-1' },
  });
  await waitFor(() => expect(result.current.connected).toBe(true));
  await rerender({ id: 'room-2' });
  await waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(result.current.connected).toBe(false));
  const second = media();
  await act(async () => next.resolve(second));
  await waitFor(() => expect(result.current.connected).toBe(true));
});

it('room:state에 전달받은 오늘 학습 시간을 보낸다', async () => {
  mockUseMock = false;
  mockConnectMedia.mockResolvedValue({
    connected: true,
    micOn: false,
    camOn: false,
    hearing: true,
    close: jest.fn(async () => {}),
    video: () => null,
  } as unknown as MediaConnection);
  await renderHook(() => useLiveRoom('room-1', true, 0, 120));
  await act(async () => {});
  expect(mockEmit).toHaveBeenCalledWith('room:state', {
    roomId: 'room-1',
    micOn: false,
    camOn: false,
    todaySec: 120,
  });
});
