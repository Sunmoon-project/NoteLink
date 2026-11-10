import { randomBytes } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parseSocialExchangeBody } from '../src/modules/auth/social-login/social-exchange-body.js';

// 서버가 내주는 코드와 앱이 보내는 codeVerifier 형식 그대로 만든다
const token = randomBytes(32).toString('base64url');
const codeVerifier = randomBytes(32).toString('hex'); // 앱: hex(32바이트) = 64자
const VALID = { token, codeVerifier };

function failure(body: unknown): BadRequestException {
  try {
    parseSocialExchangeBody(body);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return error as BadRequestException;
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

describe('parseSocialExchangeBody', () => {
  describe('정상', () => {
    it('앱이 보내는 값(token, codeVerifier)을 code, codeVerifier로 돌려준다', () => {
      expect(parseSocialExchangeBody(VALID)).toEqual({ code: token, codeVerifier });
    });

    it('알 수 없는 필드가 더 있어도 무시한다', () => {
      expect(parseSocialExchangeBody({ ...VALID, extra: 'x' })).toEqual({
        code: token,
        codeVerifier,
      });
    });

    it.each([43, 64, 128])('codeVerifier %i자는 허용한다', (length) => {
      const verifier = 'a'.repeat(length);

      expect(parseSocialExchangeBody({ ...VALID, codeVerifier: verifier }).codeVerifier).toBe(
        verifier,
      );
    });

    it('codeVerifier에 RFC 7636이 허용하는 - . _ ~ 를 쓸 수 있다', () => {
      const verifier = `${'a'.repeat(39)}-._~`;

      expect(parseSocialExchangeBody({ ...VALID, codeVerifier: verifier }).codeVerifier).toBe(
        verifier,
      );
    });
  });

  describe('token (1회용 코드)', () => {
    it.each([
      ['없음', undefined],
      ['빈 문자열', ''],
      ['42자(짧음)', 'a'.repeat(42)],
      ['44자(김)', 'a'.repeat(44)],
      ['허용되지 않는 글자 +', `${'a'.repeat(42)}+`],
      ['허용되지 않는 글자 /', `${'a'.repeat(42)}/`],
      ['패딩 =', `${'a'.repeat(42)}=`],
      ['공백 포함', `${'a'.repeat(42)} `],
      ['숫자', 12345],
      ['배열', [token]],
      ['객체', { $gt: '' }],
      ['null', null],
    ])('%s이면 거부한다', (_reason, value) => {
      const error = failure({ ...VALID, token: value });

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(error.getResponse())).toContain('token');
    });
  });

  describe('codeVerifier (PKCE 검증값)', () => {
    it.each([
      ['없음', undefined],
      ['빈 문자열', ''],
      ['42자(짧음)', 'a'.repeat(42)],
      ['129자(김)', 'a'.repeat(129)],
      ['허용되지 않는 글자 공백', `${'a'.repeat(42)} `],
      ['허용되지 않는 글자 !', `${'a'.repeat(42)}!`],
      ['허용되지 않는 글자 한글', `${'a'.repeat(42)}가`],
      ['줄바꿈', `${'a'.repeat(42)}\n`],
      ['숫자', 12345],
      ['배열', [codeVerifier]],
      ['객체', { a: 1 }],
    ])('%s이면 거부한다', (_reason, value) => {
      const error = failure({ ...VALID, codeVerifier: value });

      expect(error.getResponse()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(error.getResponse())).toContain('codeVerifier');
    });
  });

  describe('본문 자체가 이상할 때', () => {
    it.each([
      ['본문 없음(undefined)', undefined],
      ['null', null],
      ['문자열', 'text'],
      ['숫자', 5],
      ['배열', [VALID]],
      ['빈 객체', {}],
    ])('%s이면 400 { code, message } 로 거부한다', (_reason, body) => {
      const error = failure(body);

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual({
        code: 'VALIDATION_FAILED',
        message: expect.any(String),
      });
    });
  });

  it('오류 문구에 받은 값(코드 · 검증값)을 넣지 않는다', () => {
    const leaked = `${'z'.repeat(20)}!!`;

    for (const body of [
      { ...VALID, token: leaked },
      { ...VALID, codeVerifier: leaked },
    ]) {
      expect(JSON.stringify(failure(body).getResponse())).not.toContain(leaked);
    }
  });
});
