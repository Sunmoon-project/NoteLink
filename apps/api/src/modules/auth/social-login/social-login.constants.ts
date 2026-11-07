/**
 * 소셜 로그인이 끝나고 브라우저를 돌려보낼 앱 주소. 이 값 하나만 허용한다.
 * 요청이 보낸 주소로 그대로 돌려보내면 공격자가 자기 앱 주소를 넣어 1회용 코드를 가로챌 수 있다.
 * (apps/mobile/src/lib/social-auth.ts 의 REDIRECT 와 같아야 한다)
 */
export const APP_REDIRECT_URI = 'notelink://auth/callback';

/** `createGoogleConfig`로 만든 설정을 이 이름으로 넣어 둔다(auth.module에서 연결) */
export const GOOGLE_CONFIG = 'GOOGLE_CONFIG';

/** 로그인을 시작한 뒤 구글 로그인을 마칠 때까지 기다려 주는 시간 */
export const ATTEMPT_TTL_MS = 10 * 60 * 1000;
