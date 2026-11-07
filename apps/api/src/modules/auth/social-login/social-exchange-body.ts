import { BadRequestException } from '@nestjs/common';

import { VALIDATION_FAILED } from './social-start-query.js';

/** 우리가 앱에 내준 1회용 코드 = 랜덤 32바이트의 base64url(패딩 없음) = 43자 */
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** PKCE code_verifier: 43~128자의 영문 · 숫자 · - . _ ~ (RFC 7636). 앱은 hex 64자를 보낸다 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface SocialExchangeParams {
  /** 콜백에서 앱에 내준 1회용 코드 */
  code: string;
  /** 앱이 보관해 둔 PKCE 검증값. 로그인을 시작한 앱이 맞는지 확인하는 데 쓴다 */
  codeVerifier: string;
}

function invalid(field: string): BadRequestException {
  return new BadRequestException({
    code: VALIDATION_FAILED,
    message: `${field} 형식이 올바르지 않습니다`,
  });
}

/**
 * `POST /auth/social/:provider` 의 본문을 검증한다(앱: `{ token, codeVerifier }`).
 * 형식이 틀리면 400 `{ code: 'VALIDATION_FAILED', message }`. 오류 문구에는 받은 값을 넣지 않는다.
 */
export function parseSocialExchangeBody(body: unknown): SocialExchangeParams {
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const token = record['token'];
  if (typeof token !== 'string' || !CODE_PATTERN.test(token)) throw invalid('token');
  const codeVerifier = record['codeVerifier'];
  if (typeof codeVerifier !== 'string' || !VERIFIER_PATTERN.test(codeVerifier)) {
    throw invalid('codeVerifier');
  }
  return { code: token, codeVerifier };
}
