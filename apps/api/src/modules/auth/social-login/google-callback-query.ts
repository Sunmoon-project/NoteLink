import { BadRequestException } from '@nestjs/common';

import { VALIDATION_FAILED } from './social-start-query.js';

/** 서버가 만든 oauthState = 랜덤 32바이트의 base64url(패딩 없음) = 43자 */
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 구글 인증 코드는 길지 않다. 터무니없이 긴 값은 구글에 보내지 않고 거른다 */
const MAX_CODE_LENGTH = 2048;
const MAX_ERROR_LENGTH = 200;

export interface GoogleCallbackParams {
  /** 우리가 구글에 보냈다가 돌려받은 state. 이 로그인 시도를 찾는 열쇠다 */
  oauthState: string;
  /** 구글이 준 인증 코드. 사용자가 취소했으면 없다 */
  code: string | null;
  /** 구글이 준 오류(예: access_denied). 정상이면 없다 */
  error: string | null;
}

function invalid(field: string, reason: string): BadRequestException {
  return new BadRequestException({ code: VALIDATION_FAILED, message: `${field} ${reason}` });
}

/** 없으면 null, 있으면 문자열 하나여야 한다(반복된 쿼리 · 객체는 거부) */
function optionalText(query: Record<string, unknown>, field: string, max: number): string | null {
  const value = query[field];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > max)
    throw invalid(field, '형식이 올바르지 않습니다');
  return value === '' ? null : value;
}

/**
 * `GET /auth/social/google/callback` 의 쿼리를 검증한다.
 * 형식이 틀리면 400 `{ code: 'VALIDATION_FAILED', message }`. 오류 문구에는 받은 값을 넣지 않는다.
 */
export function parseGoogleCallbackQuery(query: Record<string, unknown>): GoogleCallbackParams {
  const state = query['state'];
  if (typeof state !== 'string' || !OAUTH_STATE_PATTERN.test(state)) {
    throw invalid('state', '형식이 올바르지 않습니다');
  }
  return {
    oauthState: state,
    code: optionalText(query, 'code', MAX_CODE_LENGTH),
    error: optionalText(query, 'error', MAX_ERROR_LENGTH),
  };
}
