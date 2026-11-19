import { renderHook } from '@testing-library/react-native';
import { useRoomsLive } from '../features/studyroom/room-live';

// 소켓 하나를 목록 화면과 방 화면이 함께 쓴다: 서버의 지켜보기는 소켓 · 방마다 하나라, 한쪽이 그만 볼 때
// 다른 쪽이 아직 보는 방까지 끊으면 안 된다
const mockEmit = jest.fn();
jest.mock('../lib/socket', () => ({
  socket: {
    emit: (...args: unknown[]) => mockEmit(...args),
    on: () => () => {},
    onConnection: (fn: (connected: boolean) => void) => {
      fn(true);
      return () => {};
    },
  },
}));

const unwatched = () =>
  mockEmit.mock.calls
    .filter(([ev]) => ev === 'rooms:unwatch')
    .map(([, p]) => (p as { roomIds: string[] }).roomIds);

beforeEach(() => mockEmit.mockReset());

describe('useRoomsLive 지켜보기 참조 개수', () => {
  it('같은 방을 두 화면이 지켜보면 마지막 화면이 그만 볼 때만 서버에 해제를 보낸다', async () => {
    const list = await renderHook(() => useRoomsLive(['r1', 'r2']));
    const room = await renderHook(() => useRoomsLive(['r1']));
    // 목록이 먼저 떠나도 방 화면이 보는 r1은 끊지 않는다
    await list.unmount();
    expect(unwatched()).toEqual([['r2']]);
    await room.unmount();
    expect(unwatched()).toEqual([['r2'], ['r1']]);
  });

  it('아무도 겹치지 않으면 지금처럼 그 방들을 해제한다', async () => {
    const only = await renderHook(() => useRoomsLive(['r1', 'r2']));
    await only.unmount();
    expect(unwatched()).toEqual([['r1', 'r2']]);
  });
});
