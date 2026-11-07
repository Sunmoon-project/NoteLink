import { BadRequestException } from '@nestjs/common';

import { VALIDATION_FAILED } from './social-login/social-start-query.js';

/** refresh 토큰(JWT) 하나의 상한. 서버가 발급하는 토큰은 이보다 훨씬 짧다(약 230자). 터무니없이 긴 값은 검증하지 않고 거른다 */
const MAX_TOKEN_LENGTH = 4096;
/** JWT는 점으로 구분된 세 부분(헤더.내용.서명)이고 각 부분은 base64url 글자다 */
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * `POST /auth/refresh` 의 본문(`{ refreshToken }`)을 검증한다.
 * 형식이 틀리면 400 `{ code: 'VALIDATION_FAILED', message }`. 오류 문구에는 받은 값을 넣지 않는다.
 */
export function parseRefreshBody(body: unknown): string {
  const token = record(body)['refreshToken'];
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !JWT_PATTERN.test(token)) {
    throw new BadRequestException({
      code: VALIDATION_FAILED,
      message: 'refreshToken 형식이 올바르지 않습니다',
    });
  }
  return token;
}

/**
 * `POST /auth/logout` 의 본문에서 폐기할 refresh 토큰을 꺼낸다. 없거나 이상하면 null.
 * 로그아웃은 오류를 내지 않는다: 앱이 이미 토큰을 잃은 상태에서 로그아웃을 눌러도(`{}`) 화면이 막히지 않아야 하고,
 * 토큰이 유효한지 알려 주는 단서(오류 구분)도 주지 않는다. 형식이 이상한 값은 폐기할 것이 없으니 무시한다.
 */
export function readLogoutToken(body: unknown): string | null {
  const token = record(body)['refreshToken'];
  return typeof token === 'string' && token.length <= MAX_TOKEN_LENGTH && JWT_PATTERN.test(token)
    ? token
    : null;
}
