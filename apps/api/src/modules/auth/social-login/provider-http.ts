import { SocialProviderError } from './social-provider.js';

/** 제공자가 이 시간 안에 답하지 않으면 포기한다(로그인 화면이 멈춘 채 기다리지 않게) */
const REQUEST_TIMEOUT_MS = 5_000;

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
    throw new SocialProviderError(reason, `${providerLabel} ${what} 응답 상태: ${res.status}`);
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
