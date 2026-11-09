import type { KakaoConfig } from '../../../config/kakao.config.js';

const KAKAO_AUTH_ENDPOINT = 'https://kauth.kakao.com/oauth/authorize';

/**
 * 사용자를 보낼 카카오 로그인 주소를 만든다.
 * - `state`: 이 로그인 시도를 찾는 열쇠. 카카오가 콜백에 그대로 돌려준다
 * - `prompt=select_account`: 브라우저에 카카오계정 세션이 있어도 어느 계정으로 할지 고르게 한다
 * - `scope`는 보내지 않는다. 이 값은 이미 동의받은 사용자에게 "추가" 동의를 받을 때 쓰는 것이고,
 *   카카오 개발자 콘솔 > 동의항목에서 정한 필수 항목은 동의 화면에 자동으로 나온다.
 * 주소에는 `client_secret`을 넣지 않는다(서버가 코드를 교환할 때만 쓴다).
 */
export function buildKakaoAuthUrl(config: KakaoConfig, oauthState: string): string {
  const url = new URL(KAKAO_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: config.restApiKey,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state: oauthState,
    prompt: 'select_account',
  }).toString();
  return url.toString();
}
