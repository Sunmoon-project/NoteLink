import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '@notelink/shared';
import { env } from './env';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';

// Socket.IO (NestJS realtime 게이트웨이): 채팅 · 스터디룸 상태 · AI 진행률 (p.19~20)
// 기기 저장 모드에서는 같은 모양의 로컬 이벤트 버스를 쓴다.

type Ev = keyof ServerToClient;
type Handler<E extends Ev> = ServerToClient[E];

type AnyHandler = (...args: never[]) => void;
const bus = new Map<string, Set<AnyHandler>>();
let real: Socket<ServerToClient, ClientToServer> | null = null;

/** 로그인 뒤 한 번 연결한다. 계정이 바뀌면 clearAccountState()가 끊는다 */
export function connectSocket() {
  if (env.localData || real) return;
  real = io(env.socketUrl, {
    transports: ['websocket'],
    // 다시 연결할 때마다 지금 토큰을 읽는다 (갱신된 토큰 · 다른 계정 토큰이 섞이지 않게)
    auth: (cb) => cb({ token: useAuth.getState().tokens?.accessToken }),
    reconnection: true,
  });
  real.on('connect', () => useNet.getState().set('ok'));
  real.on(
    'disconnect',
    (reason) => reason !== 'io client disconnect' && useNet.getState().set('unstable'),
  );
  // 이미 등록된 리스너를 실소켓에 붙인다
  bus.forEach((set, ev) => set.forEach((fn) => real!.on(ev as Ev, fn as never)));
}

export function disconnectSocket() {
  real?.disconnect();
  real = null;
}

export const socket = {
  on<E extends Ev>(ev: E, fn: Handler<E>) {
    if (!bus.has(ev)) bus.set(ev, new Set());
    bus.get(ev)!.add(fn as never);
    real?.on(ev, fn as never);
    return () => socket.off(ev, fn);
  },
  off<E extends Ev>(ev: E, fn: Handler<E>) {
    bus.get(ev)?.delete(fn as never);
    real?.off(ev, fn as never);
  },
  emit<E extends keyof ClientToServer>(ev: E, ...args: Parameters<ClientToServer[E]>) {
    if (real) (real.emit as (...a: unknown[]) => void)(ev, ...args);
    else localSocket.onClient?.(ev, args);
  },
};

/** 서버 없이 동작할 때 기기 저장소(lib/local)가 소켓 이벤트를 주고받는 통로 */
export const localSocket = {
  push<E extends Ev>(ev: E, ...args: Parameters<ServerToClient[E]>) {
    bus.get(ev)?.forEach((fn) => (fn as (...a: unknown[]) => void)(...args));
  },
  onClient: undefined as undefined | ((ev: string, args: unknown[]) => void),
};
