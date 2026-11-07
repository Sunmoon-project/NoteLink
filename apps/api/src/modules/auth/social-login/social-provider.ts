/** 제공자(구글 · 카카오 · 네이버)가 달라도 서버가 받는 사용자 정보의 모양은 같다 */
export interface SocialProfile {
  /** 제공자가 정해 준 고유 번호. 이메일이 바뀌어도 변하지 않아 사용자를 찾는 기준으로 쓴다 */
  providerUid: string;
  /** 제공자가 "인증된 이메일"이라고 알려 준 경우에만 담는다. 아니면 null */
  email: string | null;
  /** 닉네임 초기값을 만드는 데 쓴다. 없으면 null */
  name: string | null;
}

/**
 * - `invalid_code`: 코드가 잘못됐거나 이미 썼거나 만료됐다. 사용자가 로그인을 처음부터 다시 해야 한다
 * - `unavailable`: 제공자 장애 · 네트워크 · 응답 형식 이상 · 우리 설정 오류. 잠시 뒤 다시 시도하면 된다
 */
export type SocialProviderFailure = 'invalid_code' | 'unavailable';

/** 오류 메시지에는 코드 · 토큰 · 시크릿을 넣지 않는다. 상태 코드 같은 안전한 정보만 담는다 */
export class SocialProviderError extends Error {
  constructor(
    readonly reason: SocialProviderFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SocialProviderError';
  }
}
