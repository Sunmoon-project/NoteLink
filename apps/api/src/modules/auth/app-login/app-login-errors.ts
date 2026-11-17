/** 앱이 오류 코드로 화면을 분기한다. 공유 계약(packages/shared ERROR_CODES)에도 같은 값을 추가해야 한다 */
export const APP_LOGIN_ERRORS = {
  /** 너무 빨리 다시 요청했거나 구간 한도를 넘었다 */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 인증번호가 틀렸거나, 없거나, 만료됐거나, 이미 썼다(구분해서 알리지 않는다) */
  EMAIL_CODE_INVALID: 'EMAIL_CODE_INVALID',
  /** 틀린 입력 횟수를 모두 써서 이 인증번호는 더 이상 시도할 수 없다 */
  EMAIL_CODE_LOCKED: 'EMAIL_CODE_LOCKED',
  /** 인증 증표의 수명(10분)이 지났다. 다시 인증해야 한다 */
  EMAIL_PROOF_EXPIRED: 'EMAIL_PROOF_EXPIRED',
  /** 인증 증표가 위조됐거나 이미 썼거나 더 최근의 인증으로 대체됐다 */
  EMAIL_PROOF_INVALID: 'EMAIL_PROOF_INVALID',
  /** 이미 가입한 이메일(공유 계약 ERROR_CODES.EMAIL_TAKEN 과 같은 값) */
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /** 메일 발송 수단을 쓸 수 없다 */
  MAIL_UNAVAILABLE: 'MAIL_UNAVAILABLE',
  /**
   * 이메일 또는 비밀번호가 맞지 않다. 없는 이메일 · 소셜로만 가입한 계정 · 탈퇴한 계정 · 틀린 비밀번호를
   * 구분하지 않고 모두 이 코드 하나로 알린다(응답으로 가입 여부를 알아내지 못하게 한다).
   * 토큰 만료 코드(AUTH_TOKEN_EXPIRED)와 달라서, 앱은 이 응답을 받아도 토큰 갱신을 시도하지 않는다.
   */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /**
   * 로그인을 너무 많이 시도해 잠겼다(이메일 기준 5번). 그 이메일의 계정이 있는지와 상관없이 같은 응답이다.
   * 잠긴 동안은 맞는 비밀번호도 받지 않는다. 본문의 `retryAfterSeconds` 뒤에 다시 시도할 수 있다.
   */
  LOGIN_LOCKED: 'LOGIN_LOCKED',
} as const;
