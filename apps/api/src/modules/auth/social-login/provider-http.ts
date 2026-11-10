import { SocialProviderError } from './social-provider.js';

/** 제공자가 이 시간 안에 답하지 않으면 포기한다(로그인 화면이 멈춘 채 기다리지 않게) */
const REQUEST_TIMEOUT_MS = 5_000;

/** 오류 식별자로 인정하는 모양: 영문 · 숫자 · _ 만, 짧게 */
const SAFE_ID = /^[A-Za-z0-9_]{1,40}$/;
const MAX_MESSAGE_LENGTH = 120;
/** 인가 코드 · 토큰은 영문 · 숫자 · - _ 가 30자 넘게 이어진다 */
const LONG_TOKEN_LIKE = /[A-Za-z0-9_-]{30,}/;

export type Json = Record<string, unknown>;

/**
 * 제공자 서버에 요청을 보내고 JSON 본문을 돌려준다. 실패는 모두 SocialProviderError로 바꾼다.
 * 오류 문구에는 상태 코드처럼 안전한 정보만 담고, 코드 · 토큰 · 시크릿은 넣지 않는다.
 * @param providerLabel 오류 문구에 쓰는 제공자 이름(예: 구글)
 * @param invalidCodeStatus 이 상태 코드면 사용자의 코드 문제(`invalid_code`)로 본다. 나머지 실패는 `unavailable`
 */
export async function requestJson(
  providerLabel: string,
  url: string,
  init: RequestInit,
  what: string,
  invalidCodeStatus?: number,
): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // 비밀값이 든 요청을 다른 주소로 따라가지 않는다
      redirect: 'error',
    });
  } catch {
    throw new SocialProviderError('unavailable', `${providerLabel} ${what} 요청에 실패했습니다`);
  }
  if (!res.ok) {
    const reason = res.status === invalidCodeStatus ? 'invalid_code' : 'unavailable';
    const detail = await readErrorDetail(res);
    throw new SocialProviderError(
      reason,
      `${providerLabel} ${what} 응답 상태: ${res.status}${detail ? ` (${detail})` : ''}`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SocialProviderError('unavailable', `${providerLabel} ${what} 응답을 읽지 못했습니다`);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SocialProviderError(
      'unavailable',
      `${providerLabel} ${what} 응답 형식이 올바르지 않습니다`,
    );
  }
  return body as Json;
}

/**
 * 제공자의 오류 응답에서 원인을 알 수 있는 짧은 식별자만 꺼낸다(예: KOE320, -401, invalid_grant).
 * 코드 · 토큰이 섞일 수 있는 다른 필드(`msg`, `error_description`, 문자열 `code` 등)는 읽지 않는다.
 */
async function readErrorDetail(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return '';
  }
  if (typeof body !== 'object' || body === null) return '';
  const record = body as Json;
  const parts: string[] = [];
  const errorCode = record['error_code'];
  const error = record['error'];
  const code = record['code'];
  if (typeof errorCode === 'string' && SAFE_ID.test(errorCode)) parts.push(errorCode);
  if (typeof error === 'string' && SAFE_ID.test(error)) parts.push(error);
  if (typeof code === 'number' && Number.isInteger(code)) parts.push(String(code));
  const msg = safeMessage(record['msg']);
  if (msg) parts.push(msg);
  return parts.join(', ');
}

/**
 * 카카오 REST 오류의 `msg`(예: "ip mismatched! callerIp=…")는 원인을 바로 알려 준다.
 * 인가 코드 · 토큰이 섞여 들어올 수 있으므로, 짧고 긴 토큰 모양의 문자열이 없을 때만 쓴다.
 */
function safeMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (text === '' || text.length > MAX_MESSAGE_LENGTH || LONG_TOKEN_LIKE.test(text)) return '';
  return text;
}

/** 오류 식별자(예: invalid_request)로 안전하게 쓸 수 있는 모양이면 그 값을, 아니면 빈 문자열을 돌려준다 */
export function safeIdentifier(value: unknown): string {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : '';
}

export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/** 이메일은 users.email 규칙(소문자 · 공백 제거)에 맞춘다 */
export function cleanEmail(value: unknown): string | null {
  const email = cleanText(value);
  return email === null ? null : email.toLowerCase();
}
