/**
 * 소셜 로그인이 끝나고 브라우저를 돌려보낼 앱 주소. 이 값 하나만 허용한다.
 * 요청이 보낸 주소로 그대로 돌려보내면 공격자가 자기 앱 주소를 넣어 1회용 코드를 가로챌 수 있다.
 * (apps/mobile/src/lib/social-auth.ts 의 REDIRECT 와 같아야 한다)
 */
export const APP_REDIRECT_URI = 'notelink://auth/callback';
