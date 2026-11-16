import { ERROR_CODES, PATHS, type ApiErr } from '@notelink/shared';
import { env } from '../env';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export class NetworkError extends Error {}

type Opts = {
  query?: Record<string, string | number | boolean | undefined>;
  auth?: boolean;
  retry?: boolean;
  idempotencyKey?: string;
};

type Tokens = NonNullable<ReturnType<typeof useAuth.getState>['tokens']>;
// 같은 토큰으로 동시에 만료된 요청들은 갱신 한 번을 같이 기다린다. 토큰이 다르면(다른 계정 · 이미 갱신됨) 따로 갱신한다
let refreshing: { from: Tokens; p: Promise<boolean> } | null = null;

/** 토큰 t를 갱신한다. 갱신하는 동안 토큰이 바뀌었으면 결과를 쓰지 않는다 */
export function refreshAccessTokens(t: Tokens): Promise<boolean> {
  if (refreshing?.from === t) return refreshing.p;
  const uid = useAuth.getState().userId;
  const p = (async () => {
    try {
      const res = await fetch(env.apiUrl + PATHS.refresh, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: t.refreshToken }),
      });
      if (!res.ok) return false;
      const { data } = (await res.json()) as {
        data: { accessToken: string; refreshToken: string };
      };
      // 갱신하는 동안 로그아웃하거나 다른 계정으로 로그인했으면 이 응답은 버린다
      if (useAuth.getState().tokens !== t) return false;
      return await useAuth.getState().setTokens(data, uid);
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        if (refreshing?.from === t) refreshing = null;
      });
    }
  })();
  refreshing = { from: t, p };
  return p;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: Opts = {},
): Promise<T> {
  const qs = opts.query
    ? '?' +
      Object.entries(opts.query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  // 요청을 보낸 계정 · 토큰. 401이 늦게 와도 이 계정 기준으로만 갱신 · 재전송한다
  const sent = useAuth.getState().tokens;
  const sentUser = useAuth.getState().userId;
  const token = sent?.accessToken;
  let res: Response;
  try {
    res = await fetch(env.apiUrl + path + qs, {
      method,
      headers: {
        Accept: 'application/json',
        ...(opts.idempotencyKey && { 'Idempotency-Key': opts.idempotencyKey }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(token && opts.auth !== false && { Authorization: `Bearer ${token}` }),
      },
      // 함수 본문은 보낼 때마다 다시 읽는다 (토큰 갱신 뒤 재시도에 새 값이 들어가게)
      body:
        body === undefined ? undefined : JSON.stringify(typeof body === 'function' ? body() : body),
    });
  } catch {
    // 연결 실패 — 배너로 알리고 호출한 쪽에서 대기열/재시도 처리 (p.97)
    useNet.getState().set('unstable');
    throw new NetworkError('network');
  }
  if (useNet.getState().state === 'unstable' || useNet.getState().state === 'offline')
    useNet.getState().set('ok');

  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { data?: T } & Partial<ApiErr>;
  if (res.ok) return json.data as T;

  const code = json.code ?? 'UNKNOWN';
  if (res.status === 401 && code === ERROR_CODES.TOKEN_EXPIRED && opts.retry !== false && sent) {
    const sameUser = () => useAuth.getState().userId === sentUser;
    const retry = () => request<T>(method, path, body, { ...opts, retry: false });
    // 그 사이 다른 계정으로 바뀌었으면 새 계정 권한으로 다시 보내지 않는다
    if (!sameUser()) throw new ApiError(code, json.message ?? '로그인이 바뀌었어요', res.status);
    // 같은 계정의 다른 요청이 이미 갱신했으면 새 토큰으로 바로 다시 보낸다
    if (useAuth.getState().tokens !== sent) return retry();
    if ((await refreshAccessTokens(sent)) && sameUser()) return retry();
    // 갱신 실패를 만료로 알리는 것도 시작한 토큰이 아직 쓰이고 있을 때만
    if (useAuth.getState().tokens === sent) useAuth.getState().setExpired(true);
  }
  if (code === ERROR_CODES.MAINTENANCE) useNet.getState().set('maintenance');
  if (code === ERROR_CODES.AI_MAINTENANCE) useNet.getState().set('aiMaintenance');
  throw new ApiError(code, json.message ?? '문제가 생겼어요', res.status);
}

export const http = {
  get: <T>(p: string, query?: Opts['query']) => request<T>('GET', p, undefined, { query }),
  post: <T>(p: string, body?: unknown, opts: Pick<Opts, 'idempotencyKey'> = {}) =>
    request<T>('POST', p, body ?? {}, opts),
  patch: <T>(p: string, body: unknown) => request<T>('PATCH', p, body),
  put: <T>(p: string, body: unknown) => request<T>('PUT', p, body),
  del: <T = void>(p: string) => request<T>('DELETE', p),
};
