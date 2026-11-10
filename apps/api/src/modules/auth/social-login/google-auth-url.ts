import type { GoogleConfig } from '../../../config/google.config.js';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** 사용자 식별번호(openid), 이메일, 이름을 받는다. 이메일은 인증된 값일 때만 저장한다 */
export const GOOGLE_SCOPE = 'openid email profile';

/**
 * 사용자를 보낼 구글 로그인 주소를 만든다.
 * - `state`: 이 로그인 시도를 찾는 열쇠. 구글이 콜백에 그대로 돌려준다
 * - `prompt=select_account`: 기기에 로그인된 구글 계정이 있어도 어느 계정으로 할지 매번 고르게 한다
 * 주소에는 `client_secret`을 넣지 않는다(서버가 코드를 교환할 때만 쓴다).
 */
export function buildGoogleAuthUrl(config: GoogleConfig, oauthState: string): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    state: oauthState,
    prompt: 'select_account',
  }).toString();
  return url.toString();
}
