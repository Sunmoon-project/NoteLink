import { ERROR_CODES, PATHS } from '@notelink/shared';
import { describe, expect, it } from 'vitest';

import { APP_LOGIN_ERRORS } from '../src/modules/auth/app-login/app-login-errors.js';

// 서버(app-login-errors.ts)와 앱이 읽는 공유 계약(packages/shared)에 같은 값이 따로 적혀 있다.
// 한쪽만 바뀌면 앱이 서버의 오류 코드를 알아보지 못하므로, 두 곳이 어긋나면 여기서 실패하게 한다.
describe('서버의 오류 코드와 공유 계약이 같다', () => {
  it.each(Object.entries(APP_LOGIN_ERRORS))('%s', (key, value) => {
    expect((ERROR_CODES as Record<string, string>)[key]).toBe(value);
  });

  it('서버가 쓰는 코드는 모두 공유 계약에 있다 (서버에만 있고 앱이 모르는 코드가 없다)', () => {
    const shared = new Set(Object.values(ERROR_CODES));

    for (const code of Object.values(APP_LOGIN_ERRORS)) expect(shared.has(code)).toBe(true);
  });
});

describe('서버의 주소와 공유 계약이 같다', () => {
  it('컨트롤러가 받는 주소는 공유 계약의 주소와 같다', () => {
    expect(PATHS.emailSendCode).toBe('/auth/email/send-code');
    expect(PATHS.emailVerifyCode).toBe('/auth/email/verify-code');
    expect(PATHS.emailSignup).toBe('/auth/email/signup');
    expect(PATHS.emailLogin).toBe('/auth/email/login');
  });
});
