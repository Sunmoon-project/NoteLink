import { BadRequestException } from '@nestjs/common';

import { APP_REDIRECT_URI } from './social-login.constants.js';

/** 앱의 입력 오류 코드(packages/shared ERROR_CODES.VALIDATION 과 같은 값) */
export const VALIDATION_FAILED = 'VALIDATION_FAILED';

/** 앱이 만든 state. 앱은 랜덤 16바이트를 hex(32자)로 보내지만 길이는 넉넉하게 받는다 */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** PKCE S256 code_challenge = SHA-256(32바이트)의 base64url(패딩 없음) = 43자 (RFC 7636) */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SocialStartParams {
  /** 앱이 보낸 state. 앱으로 돌아갈 때 그대로 돌려준다 */
  appState: string;
  /** 앱이 보낸 PKCE code_challenge. 코드 교환 때 codeVerifier와 맞는지 확인한다 */
  codeChallenge: string;
}

function invalid(field: string, reason: string): BadRequestException {
  return new BadRequestException({ code: VALIDATION_FAILED, message: `${field} ${reason}` });
}

/** 같은 이름의 쿼리가 여러 번 오거나 객체로 오면 배열 · 객체가 되므로, 문자열 하나만 받는다 */
function text(query: Record<string, unknown>, field: string): string {
  const value = query[field];
  if (typeof value !== 'string' || value === '') throw invalid(field, '가 필요합니다');
  return value;
}

/**
 * `GET /auth/social/:provider/start` 의 쿼리를 검증한다.
 * 형식이 틀리면 400 `{ code: 'VALIDATION_FAILED', message }`. 오류 문구에는 받은 값을 넣지 않는다.
 */
export function parseSocialStartQuery(query: Record<string, unknown>): SocialStartParams {
  if (text(query, 'redirect') !== APP_REDIRECT_URI) {
    throw invalid('redirect', '는 허용된 앱 주소가 아닙니다');
  }
  const appState = text(query, 'state');
  if (!STATE_PATTERN.test(appState)) throw invalid('state', '형식이 올바르지 않습니다');

  const codeChallenge = text(query, 'code_challenge');
  if (!CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    throw invalid('code_challenge', '형식이 올바르지 않습니다');
  }
  if (text(query, 'code_challenge_method') !== 'S256') {
    throw invalid('code_challenge_method', '는 S256만 지원합니다');
  }
  return { appState, codeChallenge };
}
