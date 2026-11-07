import type { NaverConfig } from '../../../config/naver.config.js';

const NAVER_AUTH_ENDPOINT = 'https://nid.naver.com/oauth2.0/authorize';

/**
 * 사용자를 보낼 네이버 로그인 주소를 만든다.
 * - `state`: 이 로그인 시도를 찾는 열쇠. 네이버가 콜백에 그대로 돌려주고, 토큰 교환 때도 같은 값을 보내야 한다
 * 주소에는 `client_secret`을 넣지 않는다(서버가 코드를 교환할 때만 쓴다).
 */
export function buildNaverAuthUrl(config: NaverConfig, oauthState: string): string {
  const url = new URL(NAVER_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state: oauthState,
  }).toString();
  return url.toString();
}
