/**
 * 소셜 로그인이 끝나고 브라우저를 돌려보낼 앱 주소. 이 값 하나만 허용한다.
 * 요청이 보낸 주소로 그대로 돌려보내면 공격자가 자기 앱 주소를 넣어 1회용 코드를 가로챌 수 있다.
 * (apps/mobile/src/lib/social-auth.ts 의 REDIRECT 와 같아야 한다)
 */
export const APP_REDIRECT_URI = 'notelink://auth/callback';

/** 등록된 소셜 로그인 제공자 어댑터 목록을 이 이름으로 넣어 둔다(auth.module에서 연결) */
export const SOCIAL_PROVIDER_ADAPTERS = 'SOCIAL_PROVIDER_ADAPTERS';

/** `createGoogleConfig`로 만든 설정을 이 이름으로 넣어 둔다(auth.module에서 연결) */
export const GOOGLE_CONFIG = 'GOOGLE_CONFIG';

/** `createKakaoConfig`로 만든 설정을 이 이름으로 넣어 둔다(auth.module에서 연결) */
export const KAKAO_CONFIG = 'KAKAO_CONFIG';

/** 요청한 로그인 방식이 없을 때의 오류 코드(packages/shared ERROR_CODES.NOT_FOUND 와 같은 값) */
export const NOT_FOUND = 'NOT_FOUND';

/** 로그인을 시작한 뒤 구글 로그인을 마칠 때까지 기다려 주는 시간 */
export const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** 앱에 1회용 코드를 내준 뒤 앱이 코드를 교환할 때까지 기다려 주는 시간. 코드는 짧게 살아야 한다 */
export const CODE_TTL_MS = 2 * 60 * 1000;

/**
 * 콜백이 로그인 시도를 점유하려면 만료까지 최소한 이만큼 남아 있어야 한다.
 * 점유한 뒤 구글 호출(최대 5초씩 두 번)과 사용자 처리를 하는 동안 시도가 만료되거나 지워지지 않게 하는 여유다.
 */
export const CALLBACK_PROCESSING_MARGIN_MS = 30 * 1000;
