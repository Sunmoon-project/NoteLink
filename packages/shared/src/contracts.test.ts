import { describe, expect, it } from 'vitest';

import { ERROR_CODES, PATHS } from './contracts.js';
import { DailyRecord, Material, Notification, QuizSet } from './schemas.js';

describe('PATHS', () => {
  it('경로 조각을 인코딩해 다른 경로로 새지 않게 한다', () => {
    expect(PATHS.material('../users/me')).toBe('/materials/..%2Fusers%2Fme');
    expect(PATHS.chatMessages('a/b?c')).toBe('/chat-rooms/a%2Fb%3Fc/messages');
  });

  it('평범한 id는 그대로 둔다', () => {
    expect(PATHS.studySessionAction('abc123', 'end')).toBe('/study-sessions/abc123/end');
  });
});

describe('이메일 가입 · 로그인 계약', () => {
  it('가입은 인증번호 보내기 → 확인 → 가입 순서의 주소를 가진다', () => {
    expect(PATHS.emailSendCode).toBe('/auth/email/send-code');
    expect(PATHS.emailVerifyCode).toBe('/auth/email/verify-code');
    expect(PATHS.emailSignup).toBe('/auth/email/signup');
    expect(PATHS.emailLogin).toBe('/auth/email/login');
  });

  it('새 오류 코드의 값을 못박는다 (서버 app-login-errors.ts 와 같아야 한다)', () => {
    expect(ERROR_CODES).toMatchObject({
      RATE_LIMITED: 'RATE_LIMITED',
      EMAIL_CODE_INVALID: 'EMAIL_CODE_INVALID',
      EMAIL_CODE_LOCKED: 'EMAIL_CODE_LOCKED',
      EMAIL_PROOF_EXPIRED: 'EMAIL_PROOF_EXPIRED',
      EMAIL_PROOF_INVALID: 'EMAIL_PROOF_INVALID',
      MAIL_UNAVAILABLE: 'MAIL_UNAVAILABLE',
      INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
      LOGIN_LOCKED: 'LOGIN_LOCKED',
    });
  });

  it('기존 오류 코드의 값은 바뀌지 않았다 (앱이 이미 쓰고 있다)', () => {
    expect(ERROR_CODES.TOKEN_EXPIRED).toBe('AUTH_TOKEN_EXPIRED');
    expect(ERROR_CODES.EMAIL_TAKEN).toBe('EMAIL_TAKEN');
    expect(ERROR_CODES.VALIDATION).toBe('VALIDATION_FAILED');
    expect(ERROR_CODES.NOT_FOUND).toBe('NOT_FOUND');
  });

  it('오류 코드는 키와 값이 같거나 기존 관례를 따른다 (중복 값 없음)', () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('schemas', () => {
  it('자료 응답을 검증한다', () => {
    const ok = Material.safeParse({
      _id: 'm1',
      folderId: 'f1',
      kind: 'handwriting',
      source: 'camera',
      title: '필기',
      description: null,
      avatarItemId: null,
      processing: { status: 'done', progress: 100, jobId: null },
      summary: null,
      keywords: [],
      bookmarks: [],
      createdAt: '2026-10-26T00:00:00Z',
    });
    expect(ok.success).toBe(true);
  });

  it('알 수 없는 퀴즈 상태는 거절한다', () => {
    const r = QuizSet.shape.status.safeParse('unknown');
    expect(r.success).toBe(false);
  });
});

describe('날짜 형식', () => {
  it('UTC 시각과 서울 날짜 형식만 받는다', () => {
    const n = {
      _id: 'n1',
      userId: 'u1',
      type: 'x',
      title: 't',
      body: 'b',
      data: null,
      readAt: null,
    };
    expect(Notification.safeParse({ ...n, createdAt: '2026-10-27T03:00:00.000Z' }).success).toBe(
      true,
    );
    expect(Notification.safeParse({ ...n, createdAt: '어제' }).success).toBe(false);
  });
});

describe('서울 날짜 계약', () => {
  it('실제 존재하는 YYYY-MM-DD 날짜만 받는다', () => {
    const date = DailyRecord.shape.studyDate;
    expect(date.safeParse('2028-02-29').success).toBe(true);
    expect(date.safeParse('2026-10-31').success).toBe(true);
    expect(date.safeParse('2026-02-30').success).toBe(false);
    expect(date.safeParse('2026-10-31T00:00:00Z').success).toBe(false);
    expect(date.safeParse('오늘').success).toBe(false);
  });
});
