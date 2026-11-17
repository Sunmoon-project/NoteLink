import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  parseLoginBody,
  parseSendCodeBody,
  parseSignupBody,
  parseVerifyCodeBody,
  readEmail,
  readLoginPassword,
  readNewPassword,
} from '../src/modules/auth/app-login/app-login-input.js';

/** 검증이 실패했을 때 던지는 400 { code, message } 를 꺼낸다. 던지지 않으면 시험을 실패시킨다 */
function rejection(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as { code: string; message: string };
  }
  throw new Error('검증이 실패해야 하는데 통과했다');
}

// 유효한 JWT 모양(서명이 맞는지는 이 단계에서 보지 않는다. 모양만 본다)
const PROOF = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

describe('readEmail', () => {
  it('유효한 이메일을 돌려준다', () => {
    expect(readEmail({ email: 'student@example.com' })).toBe('student@example.com');
  });

  it('앞뒤 공백을 지우고 소문자로 바꾼다 (users.email 저장 형식)', () => {
    expect(readEmail({ email: '  Student@Example.COM \n' })).toBe('student@example.com');
  });

  it('대소문자만 다른 주소는 같은 값이 된다 (중복 가입 방지)', () => {
    expect(readEmail({ email: 'A@B.com' })).toBe(readEmail({ email: 'a@b.COM' }));
  });

  it.each([
    ['플러스 주소', 'a+tag@example.com'],
    ['하위 도메인', 'a@mail.example.co.kr'],
    ['점이 있는 아이디', 'first.last@example.com'],
    ['퓨니코드 최상위', 'a@example.xn--p1ai'],
    ['한글 아이디', '학생@example.com'],
    ['최상위 2자', 'a@b.io'],
  ])('%s는 허용한다', (_reason, email) => {
    expect(() => readEmail({ email })).not.toThrow();
  });

  it.each([
    ['빈 문자열', ''],
    ['공백뿐', '   '],
    ['@ 없음', 'student.example.com'],
    ['@ 두 개', 'a@b@example.com'],
    ['아이디 없음', '@example.com'],
    ['도메인 없음', 'a@'],
    ['최상위 도메인 없음', 'a@example'],
    ['최상위 1자', 'a@example.c'],
    ['최상위에 숫자', 'a@example.c1'],
    ['중간 공백', 'a b@example.com'],
    ['연속 점', 'a..b@example.com'],
    ['도메인에 연속 점', 'a@example..com'],
    ['쉼표로 다른 사람을 끼워 넣음', 'x1,victim@example.com'],
    ['쉼표로 두 주소', 'a@example.com,b@example.com'],
    ['세미콜론으로 두 주소', 'a@example.com;b@example.com'],
    ['이름이 붙은 형식', 'Name <a@example.com>'],
    ['따옴표 아이디', '"x,y"@example.com'],
    ['줄바꿈으로 헤더 끼워 넣기', 'a@example.com\r\nBcc: evil@example.com'],
  ])('%s이면 400 VALIDATION_FAILED이다', (_reason, email) => {
    expect(rejection(() => readEmail({ email })).code).toBe('VALIDATION_FAILED');
  });

  it('254자까지 허용하고 255자부터 거부한다', () => {
    const at = (n: number) => `${'a'.repeat(n - '@example.com'.length)}@example.com`;
    expect(() => readEmail({ email: at(254) })).not.toThrow();
    expect(rejection(() => readEmail({ email: at(255) })).message).toBe('email 가 너무 깁니다');
  });

  it.each([
    ['없음', {}],
    ['숫자', { email: 123 }],
    ['null', { email: null }],
    ['배열', { email: ['a@b.com'] }],
    ['객체', { email: { a: 1 } }],
  ])('email이 %s이면 400이다', (_reason, body) => {
    expect(rejection(() => readEmail(body as Record<string, unknown>)).message).toBe(
      'email 가 필요합니다',
    );
  });

  it('오류 문구에 받은 값을 넣지 않는다', () => {
    const secretLike = 'not-an-email-SECRET-123';

    expect(rejection(() => readEmail({ email: secretLike })).message).not.toContain(secretLike);
  });
});

describe('readNewPassword (가입용: 앱 passwordError와 같은 규칙)', () => {
  it('규칙을 지키면 입력 그대로 돌려준다 (소문자 · 공백 처리 등 가공 없음)', () => {
    expect(readNewPassword({ password: 'Passw0rdOK' })).toBe('Passw0rdOK');
  });

  it('최소 8자 / 최대 64자 경계를 지킨다', () => {
    expect(() => readNewPassword({ password: 'abcdef1' })).toThrow(BadRequestException);
    expect(() => readNewPassword({ password: 'abcdefg1' })).not.toThrow();
    expect(() => readNewPassword({ password: `${'a'.repeat(63)}1` })).not.toThrow();
    expect(() => readNewPassword({ password: `${'a'.repeat(64)}1` })).toThrow(BadRequestException);
  });

  it.each([
    ['빈 문자열', ''],
    ['공백 포함', 'abc 1234'],
    ['앞에 공백', ' abcd1234'],
    ['뒤에 공백', 'abcd1234 '],
    ['탭 포함', 'abcd\t1234'],
    ['줄바꿈 포함', 'abcd\n1234'],
    ['숫자 없음', 'abcdefghij'],
    ['영문 없음', '1234567890'],
    ['한글과 숫자뿐', '가나다라마바사12'],
    ['특수문자와 숫자뿐', '!@#$%^&*12'],
  ])('%s이면 거부한다', (_reason, password) => {
    expect(rejection(() => readNewPassword({ password })).code).toBe('VALIDATION_FAILED');
  });

  it('빈 문자열은 "너무 짧다"가 아니라 "필요하다"로 알린다 (아무것도 입력하지 않은 것과 짧게 입력한 것을 구분)', () => {
    expect(rejection(() => readNewPassword({ password: '' })).message).toBe(
      'password 가 필요합니다',
    );
    expect(rejection(() => readNewPassword({ password: 'a1' })).message).toBe(
      'password 가 너무 짧습니다',
    );
  });

  it('특수문자와 한글이 섞여도 영문과 숫자가 있으면 허용한다', () => {
    expect(() => readNewPassword({ password: 'ab12!@#가' })).not.toThrow();
  });

  it('72바이트를 넘으면 거부한다 (bcrypt는 앞 72바이트만 반영하므로 뒷부분이 무시되어 버린다)', () => {
    // 'a1' + 한글 24자 = 2 + 72 = 74바이트, 글자 수는 26자라 글자 수 검사로는 못 막는다
    const longByBytes = `a1${'가'.repeat(24)}`;
    expect(longByBytes.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(longByBytes)).toBeGreaterThan(72);

    expect(rejection(() => readNewPassword({ password: longByBytes })).message).toBe(
      'password 가 너무 깁니다',
    );
  });

  it('정확히 72바이트는 허용한다', () => {
    const exactly72 = `a1${'가'.repeat(23)}a`; // 2 + 69 + 1 = 72바이트
    expect(Buffer.byteLength(exactly72)).toBe(72);

    expect(() => readNewPassword({ password: exactly72 })).not.toThrow();
  });

  it.each([
    ['없음', {}],
    ['숫자', { password: 12345678 }],
    ['null', { password: null }],
    ['배열', { password: ['abcd1234'] }],
  ])('password가 %s이면 400이다', (_reason, body) => {
    expect(rejection(() => readNewPassword(body as Record<string, unknown>)).message).toBe(
      'password 가 필요합니다',
    );
  });

  it('오류 문구에 비밀번호를 넣지 않는다', () => {
    const password = 'onlyletters-PRIVATE';

    expect(rejection(() => readNewPassword({ password })).message).not.toContain('PRIVATE');
  });
});

describe('readLoginPassword (로그인용: 형식은 느슨하게)', () => {
  it('규칙에 안 맞는 옛 비밀번호도 받는다 (가입 규칙이 바뀌어도 기존 계정이 들어올 수 있어야 한다)', () => {
    expect(readLoginPassword({ password: 'short' })).toBe('short');
    expect(readLoginPassword({ password: 'has space 1' })).toBe('has space 1');
  });

  it('입력을 가공하지 않는다 (앞뒤 공백도 그대로)', () => {
    expect(readLoginPassword({ password: ' pw ' })).toBe(' pw ');
  });

  it('빈 문자열은 거부한다', () => {
    expect(rejection(() => readLoginPassword({ password: '' })).message).toBe(
      'password 가 필요합니다',
    );
  });

  it('터무니없이 긴 값은 bcrypt에 넘기지 않고 거부한다 (144바이트 초과)', () => {
    expect(() => readLoginPassword({ password: 'a'.repeat(144) })).not.toThrow();
    expect(rejection(() => readLoginPassword({ password: 'a'.repeat(145) })).message).toBe(
      'password 가 너무 깁니다',
    );
  });

  it.each([
    ['없음', {}],
    ['숫자', { password: 1 }],
    ['객체', { password: { a: 1 } }],
  ])('password가 %s이면 400이다', (_reason, body) => {
    expect(rejection(() => readLoginPassword(body as Record<string, unknown>)).code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('parseSendCodeBody', () => {
  it('{ email }을 돌려준다 (소문자 · 공백 제거)', () => {
    expect(parseSendCodeBody({ email: ' A@B.com ' })).toEqual({ email: 'a@b.com' });
  });

  it.each([
    ['본문 없음', undefined],
    ['null', null],
    ['문자열', 'a@b.com'],
    ['배열', [{ email: 'a@b.com' }]],
    ['이메일 없음', {}],
  ])('%s이면 400이다', (_reason, body) => {
    expect(rejection(() => parseSendCodeBody(body)).code).toBe('VALIDATION_FAILED');
  });

  it('필요 없는 필드는 무시한다', () => {
    expect(parseSendCodeBody({ email: 'a@b.com', isAdmin: true })).toEqual({ email: 'a@b.com' });
  });
});

describe('parseVerifyCodeBody', () => {
  it('{ email, code }를 돌려준다', () => {
    expect(parseVerifyCodeBody({ email: 'A@b.com', code: '012345' })).toEqual({
      email: 'a@b.com',
      code: '012345',
    });
  });

  it('앞자리가 0인 코드도 문자열 그대로 받는다 (숫자로 바꾸면 앞의 0이 사라진다)', () => {
    expect(parseVerifyCodeBody({ email: 'a@b.com', code: '000001' }).code).toBe('000001');
  });

  it.each([
    ['5자리', '12345'],
    ['7자리', '1234567'],
    ['문자 포함', '12345a'],
    ['공백 포함', '123 45'],
    ['앞뒤 공백', ' 123456'],
    ['빈 문자열', ''],
    ['소수점', '12345.'],
    ['전각 숫자', '１２３４５６'],
    ['음수', '-12345'],
  ])('코드가 %s이면 400이다', (_reason, code) => {
    expect(rejection(() => parseVerifyCodeBody({ email: 'a@b.com', code })).message).toBe(
      'code 는 6자리 숫자여야 합니다',
    );
  });

  it('코드가 숫자 타입이면 거부한다 (앞의 0을 잃은 값이 올 수 있다)', () => {
    expect(rejection(() => parseVerifyCodeBody({ email: 'a@b.com', code: 123456 })).message).toBe(
      'code 가 필요합니다',
    );
  });

  it('이메일이 틀려도 400이다', () => {
    expect(rejection(() => parseVerifyCodeBody({ email: 'nope', code: '123456' })).message).toBe(
      'email 형식이 올바르지 않습니다',
    );
  });

  it('오류 문구에 받은 코드를 넣지 않는다', () => {
    expect(
      rejection(() => parseVerifyCodeBody({ email: 'a@b.com', code: '9999x9' })).message,
    ).not.toContain('9999');
  });
});

describe('parseSignupBody', () => {
  it('{ verificationToken, password }를 돌려준다', () => {
    expect(parseSignupBody({ verificationToken: PROOF, password: 'Passw0rdOK' })).toEqual({
      verificationToken: PROOF,
      password: 'Passw0rdOK',
    });
  });

  it('이메일을 받지 않는다 (인증한 이메일은 증표 안에만 있다. 본문에 이메일이 와도 무시한다)', () => {
    const parsed = parseSignupBody({
      verificationToken: PROOF,
      password: 'Passw0rdOK',
      email: 'attacker@evil.com',
    });

    expect(Object.keys(parsed).sort()).toEqual(['password', 'verificationToken']);
  });

  it.each([
    ['JWT 모양이 아님', 'not-a-jwt'],
    ['점이 두 개가 아님', 'a.b'],
    ['빈 문자열', ''],
    ['공백 포함', 'a b.c.d'],
    ['너무 김', `${'a'.repeat(2048)}.b.c`],
  ])('증표가 %s이면 400이다', (_reason, verificationToken) => {
    expect(
      rejection(() => parseSignupBody({ verificationToken, password: 'Passw0rdOK' })).code,
    ).toBe('VALIDATION_FAILED');
  });

  it('비밀번호 규칙을 어기면 400이다', () => {
    expect(
      rejection(() => parseSignupBody({ verificationToken: PROOF, password: 'short1' })).message,
    ).toBe('password 가 너무 짧습니다');
  });

  it('증표 검사가 비밀번호 검사보다 먼저다 (증표가 없는 요청에 비밀번호 규칙을 알려 주지 않는다)', () => {
    expect(rejection(() => parseSignupBody({ password: 'short' })).message).toBe(
      'verificationToken 가 필요합니다',
    );
  });

  it('오류 문구에 증표 · 비밀번호를 넣지 않는다', () => {
    const msg = rejection(() =>
      parseSignupBody({ verificationToken: 'secret-token-value', password: 'Passw0rdOK' }),
    ).message;

    expect(msg).not.toContain('secret-token-value');
  });
});

describe('parseLoginBody', () => {
  it('{ email, password }를 돌려준다 (이메일만 소문자 · 공백 제거)', () => {
    expect(parseLoginBody({ email: ' A@B.com ', password: ' Pw ' })).toEqual({
      email: 'a@b.com',
      password: ' Pw ',
    });
  });

  it('가입 규칙에 안 맞는 옛 비밀번호로도 로그인 요청은 통과한다 (계정 확인은 다음 단계)', () => {
    expect(() => parseLoginBody({ email: 'a@b.com', password: 'x' })).not.toThrow();
  });

  it.each([
    ['본문 없음', undefined],
    ['이메일 없음', { password: 'abcd1234' }],
    ['비밀번호 없음', { email: 'a@b.com' }],
    ['이메일 형식 오류', { email: 'a', password: 'abcd1234' }],
  ])('%s이면 400이다', (_reason, body) => {
    expect(rejection(() => parseLoginBody(body)).code).toBe('VALIDATION_FAILED');
  });
});
