import { BadRequestException } from '@nestjs/common';

import { VALIDATION_FAILED } from '../social-login/social-start-query.js';

/**
 * 앱 자체 가입 · 로그인의 입력 검증.
 * 규칙은 앱(apps/mobile/src/lib/validation.ts)과 같게 맞춘다. 앱이 허용하는 입력을 서버가 거부하면 가입이 막히고,
 * 서버가 더 느슨하면 앱을 거치지 않은 요청이 규칙을 우회한다. 앱 검사는 편의일 뿐이라 서버가 반드시 다시 검사한다.
 * 오류 문구에는 받은 값(이메일 · 비밀번호 · 코드)을 넣지 않는다.
 */

/** 아이디@도메인.최상위(영문 2자 이상 · 퓨니코드 xn--) · 공백 · 연속 점 없이 · 254자 이하 (앱 emailError와 같다) */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.(?:[A-Za-z]{2,}|xn--[A-Za-z0-9-]+)$/;
const EMAIL_MAX_LENGTH = 254;

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 64;
/** bcrypt는 앞 72바이트만 반영한다. 64자라도 한글이면 192바이트라 글자 수가 아니라 바이트로 막아야 한다 */
const PASSWORD_MAX_BYTES = 72;

/** 이메일로 보내는 인증번호: 6자리 숫자 (기획서 FR-01-04) */
export const EMAIL_CODE_LENGTH = 6;
const EMAIL_CODE_PATTERN = new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`);

/** 인증 증표(verify-code가 발급하는 단기 토큰)는 JWT 모양이다. 터무니없이 긴 값은 검증하지 않고 거른다 */
const PROOF_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PROOF_MAX_LENGTH = 2048;

function invalid(field: string, reason: string): BadRequestException {
  return new BadRequestException({ code: VALIDATION_FAILED, message: `${field} ${reason}` });
}

/** 본문이 객체가 아니면(배열 · 문자열 · 없음) 빈 객체로 본다. 이후 필드 검사에서 "가 필요합니다"로 거절된다 */
function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** 문자열 하나만 받는다(숫자 · 배열 · 객체는 거부) */
function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw invalid(field, '가 필요합니다');
  return value;
}

/**
 * 이메일을 검증하고 저장 형식(앞뒤 공백 제거 + 소문자)으로 돌려준다.
 * `users.email`이 소문자 · 공백 제거로 저장되므로, 같은 주소가 대소문자만 달라 중복 가입되지 않게 한다.
 */
export function readEmail(body: Record<string, unknown>, field = 'email'): string {
  const email = text(body, field).trim();
  if (email === '') throw invalid(field, '가 필요합니다');
  if (email.length > EMAIL_MAX_LENGTH) throw invalid(field, '가 너무 깁니다');
  if (!EMAIL_PATTERN.test(email) || email.includes('..')) {
    throw invalid(field, '형식이 올바르지 않습니다');
  }
  return email.toLowerCase();
}

/**
 * 가입용 비밀번호: 8~64자 · 공백 없음 · 영문과 숫자를 모두 포함 · 72바이트 이하.
 * 앞뒤 공백을 지우지 않는다(공백이 있으면 거부). 사용자가 입력한 그대로가 비밀번호다.
 */
export function readNewPassword(body: Record<string, unknown>, field = 'password'): string {
  const password = text(body, field);
  if (password === '') throw invalid(field, '가 필요합니다');
  if (/\s/.test(password)) throw invalid(field, '에는 공백을 넣을 수 없습니다');
  if (password.length < PASSWORD_MIN_LENGTH) throw invalid(field, '가 너무 짧습니다');
  if (password.length > PASSWORD_MAX_LENGTH) throw invalid(field, '가 너무 깁니다');
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    throw invalid(field, '가 너무 깁니다');
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw invalid(field, '는 영문과 숫자를 모두 포함해야 합니다');
  }
  return password;
}

/**
 * 로그인용 비밀번호: 형식 규칙은 보지 않고 비어 있지 않은 문자열이면 받는다(가입 규칙이 바뀌어도 옛 계정이 들어올 수 있게).
 * 다만 길이 상한은 둔다. 터무니없이 긴 값을 bcrypt에 넘기면 서버가 낭비된다.
 */
export function readLoginPassword(body: Record<string, unknown>, field = 'password'): string {
  const password = text(body, field);
  if (password === '') throw invalid(field, '가 필요합니다');
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES * 2) {
    throw invalid(field, '가 너무 깁니다');
  }
  return password;
}

function readCode(body: Record<string, unknown>): string {
  const code = text(body, 'code');
  if (!EMAIL_CODE_PATTERN.test(code))
    throw invalid('code', `는 ${EMAIL_CODE_LENGTH}자리 숫자여야 합니다`);
  return code;
}

function readProof(body: Record<string, unknown>): string {
  const proof = text(body, 'verificationToken');
  if (proof === '') throw invalid('verificationToken', '이 필요합니다');
  if (proof.length > PROOF_MAX_LENGTH || !PROOF_PATTERN.test(proof)) {
    throw invalid('verificationToken', '형식이 올바르지 않습니다');
  }
  return proof;
}

/** `POST /auth/email/send-code` 본문: `{ email }` */
export function parseSendCodeBody(body: unknown): { email: string } {
  return { email: readEmail(asRecord(body)) };
}

/** `POST /auth/email/verify-code` 본문: `{ email, code }` */
export function parseVerifyCodeBody(body: unknown): { email: string; code: string } {
  const record = asRecord(body);
  return { email: readEmail(record), code: readCode(record) };
}

/** `POST /auth/email/signup` 본문: `{ verificationToken, password }` (이메일은 증표에 들어 있다) */
export function parseSignupBody(body: unknown): { verificationToken: string; password: string } {
  const record = asRecord(body);
  return { verificationToken: readProof(record), password: readNewPassword(record) };
}

/** `POST /auth/email/login` 본문: `{ email, password }` */
export function parseLoginBody(body: unknown): { email: string; password: string } {
  const record = asRecord(body);
  return { email: readEmail(record), password: readLoginPassword(record) };
}
