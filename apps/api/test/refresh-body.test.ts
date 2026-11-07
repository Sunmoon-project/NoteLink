import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { parseRefreshBody, readLogoutToken } from '../src/modules/auth/refresh-body.js';

// 서버가 발급하는 refresh 토큰과 같은 모양(JWT)을 만든다
const jwt = new JwtService();
const token = jwt.sign({ sub: 'u', jti: 'j' }, { secret: 'x'.repeat(32), expiresIn: '14d' });

function failure(body: unknown): BadRequestException {
  try {
    parseRefreshBody(body);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return error as BadRequestException;
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

describe('parseRefreshBody', () => {
  it('서버가 발급하는 JWT 모양의 refreshToken을 통과시킨다', () => {
    expect(parseRefreshBody({ refreshToken: token })).toBe(token);
  });

  it('알 수 없는 필드가 더 있어도 무시한다', () => {
    expect(parseRefreshBody({ refreshToken: token, extra: 1 })).toBe(token);
  });

  it.each([
    ['본문 없음(undefined)', undefined],
    ['null', null],
    ['문자열', token],
    ['배열', [{ refreshToken: token }]],
    ['빈 객체', {}],
    ['refreshToken이 null', { refreshToken: null }],
    ['refreshToken이 빈 문자열', { refreshToken: '' }],
    ['refreshToken이 숫자', { refreshToken: 123 }],
    ['refreshToken이 배열', { refreshToken: [token] }],
    ['refreshToken이 객체', { refreshToken: { $gt: '' } }],
    ['점이 두 개가 아님', { refreshToken: 'aaa.bbb' }],
    ['점이 세 개', { refreshToken: 'aaa.bbb.ccc.ddd' }],
    ['빈 부분이 있음', { refreshToken: 'aaa..ccc' }],
    ['허용되지 않는 글자(공백)', { refreshToken: 'aaa.bbb.cc c' }],
    ['허용되지 않는 글자(+)', { refreshToken: 'aaa.bbb.cc+c' }],
    ['앞뒤 공백', { refreshToken: ` ${token} ` }],
    ['줄바꿈 포함', { refreshToken: `${token}\n` }],
    [
      '너무 긴 값(4097자)',
      { refreshToken: `${'a'.repeat(2000)}.${'b'.repeat(2000)}.${'c'.repeat(97)}` },
    ],
  ])('%s이면 400 { code, message } 로 거부한다', (_reason, body) => {
    const error = failure(body);

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
  });

  it('상한(4096자) 이하의 JWT 모양은 통과시킨다', () => {
    const edge = `${'a'.repeat(2000)}.${'b'.repeat(2000)}.${'c'.repeat(94)}`; // 정확히 4096자

    expect(edge).toHaveLength(4096);
    expect(parseRefreshBody({ refreshToken: edge })).toBe(edge);
  });

  it('오류 문구에 받은 값을 넣지 않는다', () => {
    const leaked = 'secret-looking-value!';

    expect(JSON.stringify(failure({ refreshToken: leaked }).getResponse())).not.toContain(leaked);
  });
});

describe('readLogoutToken (로그아웃은 오류를 내지 않는다)', () => {
  it('올바른 refreshToken은 돌려준다', () => {
    expect(readLogoutToken({ refreshToken: token })).toBe(token);
  });

  it.each([
    ['본문 없음', undefined],
    ['null', null],
    ['빈 객체(앱이 토큰을 잃은 상태에서 로그아웃)', {}],
    ['refreshToken이 undefined(JSON으로 직렬화되면 사라짐)', { refreshToken: undefined }],
    ['빈 문자열', { refreshToken: '' }],
    ['숫자', { refreshToken: 5 }],
    ['배열', { refreshToken: [token] }],
    ['JWT 모양이 아님', { refreshToken: 'not-a-jwt' }],
    ['너무 긴 값', { refreshToken: 'a'.repeat(5000) }],
    ['문자열 본문', 'refreshToken'],
    ['배열 본문', [token]],
  ])('%s이면 null이다 (예외를 던지지 않는다)', (_reason, body) => {
    expect(() => readLogoutToken(body)).not.toThrow();
    expect(readLogoutToken(body)).toBeNull();
  });
});
