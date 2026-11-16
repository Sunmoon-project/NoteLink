import { io, type Socket } from 'socket.io-client';
import type { ClientToServer, ServerToClient } from '@notelink/shared';
import { env } from './env';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';
import { refreshAccessTokens } from './api/http';
import { AppState } from 'react-native';

// Socket.IO (NestJS realtime 게이트웨이): 채팅 · 스터디룸 상태 · AI 진행률 (p.19~20)
// 기기 저장 모드에서는 같은 모양의 로컬 이벤트 버스를 쓴다.

type Ev = keyof ServerToClient;
type Handler<E extends Ev> = ServerToClient[E];

type AnyHandler = (...args: never[]) => void;
const bus = new Map<string, Set<AnyHandler>>();
let real: Socket<ServerToClient, ClientToServer> | null = null;
let boundToken: string | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshingSocket: Socket<ServerToClient, ClientToServer> | null = null;
let appStateSubscription: { remove(): void } | undefined;
const connectionListeners = new Set<(connected: boolean) => void>();
const notifyConnection = (connected: boolean) => connectionListeners.forEach((fn) => fn(connected));

// JWT의 exp는 갱신 시점을 정하는 데만 사용한다. 인증은 서버가 검증한다.
export function accessTokenExpiry(token: string): number | null {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bits = 0;
    let buffer = 0;
    let decoded = '';
    for (const char of encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')) {
      const value = alphabet.indexOf(char);
      if (value < 0) return null;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        decoded += String.fromCharCode((buffer >> bits) & 255);
        buffer &= (1 << bits) - 1;
      }
    }
    const { exp } = JSON.parse(decoded) as { exp?: unknown };
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function scheduleRefresh(token: string, delay?: number) {
  clearTimeout(refreshTimer);
  const expiresAt = accessTokenExpiry(token);
  if (delay === undefined && expiresAt === null) return;
  const remaining = expiresAt === null ? 0 : expiresAt - Date.now();
  const wait = delay ?? Math.max(0, remaining - Math.min(30_000, Math.max(0, remaining / 2)));
  refreshTimer = setTimeout(() => void renewSocketToken(token), Math.min(wait, 2_147_483_647));
}

async function renewSocketToken(expected: string) {
  const source = real;
  const auth = useAuth.getState();
  const tokens = auth.tokens;
  if (!source || !tokens || tokens.accessToken !== expected || refreshingSocket === source) return;
  const userId = auth.userId;
  refreshingSocket = source;
  try {
    const refreshed = await refreshAccessTokens(tokens);
    if (real !== source || useAuth.getState().userId !== userId) return;
    const current = useAuth.getState().tokens?.accessToken;
    if (!current) return;
    if (refreshed || current !== expected) {
      connectSocket();
    } else {
      // 오프라인이나 일시 장애에서는 기존 로그인 정보를 버리지 않고 다시 시도한다.
      scheduleRefresh(current, 5_000);
    }
  } finally {
    if (refreshingSocket === source) refreshingSocket = null;
  }
}

/** 로그인 뒤 한 번 연결한다. 계정이 바뀌면 clearAccountState()가 끊는다 */
export function connectSocket() {
  if (env.localData) return;
  const token = useAuth.getState().tokens?.accessToken;
  if (!token) return;
  if (real) {
    if (boundToken !== token) {
      boundToken = token;
      real.disconnect();
      real.connect();
    }
    scheduleRefresh(token);
    return;
  }
  boundToken = token;
  real = io(env.socketUrl, {
    transports: ['websocket'],
    // 다시 연결할 때마다 지금 토큰을 읽는다 (갱신된 토큰 · 다른 계정 토큰이 섞이지 않게)
    auth: (cb) => cb({ token: useAuth.getState().tokens?.accessToken }),
    reconnection: true,
  });
  const source = real;
  real.on('connect', () => {
    if (real !== source) return;
    useNet.getState().set('ok');
    notifyConnection(true);
  });
  real.on('disconnect', () => {
    if (real !== source) return;
    useNet.getState().set('unstable');
    notifyConnection(false);
  });
  real.on('connect_error', (error) => {
    if (real !== source) return;
    useNet.getState().set('unstable');
    if (error.message === 'unauthorized') {
      const current = useAuth.getState().tokens?.accessToken;
      if (current) void renewSocketToken(current);
    }
  });
  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active' || real !== source) return;
    const current = useAuth.getState().tokens?.accessToken;
    if (!current) return;
    const expiresAt = accessTokenExpiry(current);
    if (expiresAt !== null && expiresAt <= Date.now() + 30_000) void renewSocketToken(current);
    else if (!source.connected && !source.active) source.connect();
  });
  scheduleRefresh(token);
  // 이미 등록된 리스너를 실소켓에 붙인다
  bus.forEach((set, ev) => set.forEach((fn) => real!.on(ev as Ev, fn as never)));
}

export function disconnectSocket() {
  const previous = real;
  real = null;
  boundToken = undefined;
  clearTimeout(refreshTimer);
  refreshTimer = undefined;
  appStateSubscription?.remove();
  appStateSubscription = undefined;
  previous?.disconnect();
  notifyConnection(false);
}

export const socket = {
  onConnection(fn: (connected: boolean) => void) {
    connectionListeners.add(fn);
    if (env.localData || real?.connected) fn(true);
    return () => connectionListeners.delete(fn);
  },
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
