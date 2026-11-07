import { APP_REDIRECT_URI } from './social-login.constants.js';

/**
 * 앱으로 돌려보낼 때 쓰는 오류 값. 구글이 준 오류 문자열은 그대로 넘기지 않고 이 중 하나로 바꾼다.
 * 앱은 `code`가 없으면 모두 "간편 로그인을 마치지 못했어요"로 안내한다.
 * - `access_denied`: 사용자가 구글 화면에서 취소했다
 * - `invalid_code`: 구글 코드가 잘못됐거나 이미 썼거나 만료됐다
 * - `unavailable`: 구글 장애 · 네트워크 문제
 * - `server_error`: 우리 서버 안의 예상 못 한 오류
 */
export type AppRedirectError = 'access_denied' | 'invalid_code' | 'unavailable' | 'server_error';

export type AppRedirect =
  { code: string; state: string } | { error: AppRedirectError; state: string };

/**
 * 브라우저를 앱으로 돌려보낼 주소를 만든다: `notelink://auth/callback?code=…&state=…`
 * 앱은 복귀 주소가 정확히 `notelink://auth/callback`이고 state가 자기가 보낸 값과 같을 때만 코드를 믿는다.
 */
export function buildAppRedirect(redirect: AppRedirect): string {
  const params = new URLSearchParams();
  if ('code' in redirect) params.set('code', redirect.code);
  else params.set('error', redirect.error);
  params.set('state', redirect.state);
  return `${APP_REDIRECT_URI}?${params.toString()}`;
}
