import type { ConfigReader } from './mongo.config.js';
import { requiredEnv, requiredRedirectUri } from './oauth-config.js';

/** 카카오가 로그인 후 사용자를 돌려보낼 서버 주소의 경로. 컨트롤러의 실제 경로와 같아야 한다 */
export const KAKAO_CALLBACK_PATH = '/api/v1/auth/social/kakao/callback';

export interface KakaoConfig {
  /** 카카오 개발자 콘솔 > 앱 > 플랫폼 키 > REST API 키 */
  restApiKey: string;
  /** 같은 화면의 클라이언트 시크릿. REST API 키는 기본으로 켜져 있어 토큰 요청에 꼭 필요하다 */
  clientSecret: string;
  redirectUri: string;
}

export function createKakaoConfig(config: ConfigReader): KakaoConfig {
  return {
    restApiKey: requiredEnv(config, 'KAKAO_REST_API_KEY'),
    clientSecret: requiredEnv(config, 'KAKAO_CLIENT_SECRET'),
    redirectUri: requiredRedirectUri(config, 'KAKAO_REDIRECT_URI', KAKAO_CALLBACK_PATH, '카카오'),
  };
}
