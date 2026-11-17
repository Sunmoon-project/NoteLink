import type { ConfigReader } from './mongo.config.js';
import { requiredEnv, requiredRedirectUri } from './oauth-config.js';

/** 네이버가 로그인 후 사용자를 돌려보낼 서버 주소의 경로. 컨트롤러의 실제 경로와 같아야 한다 */
export const NAVER_CALLBACK_PATH = '/api/v1/auth/social/naver/callback';

export interface NaverConfig {
  /** 네이버 개발자센터 > 애플리케이션 > 내 애플리케이션의 Client ID */
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createNaverConfig(config: ConfigReader): NaverConfig {
  return {
    clientId: requiredEnv(config, 'NAVER_CLIENT_ID'),
    clientSecret: requiredEnv(config, 'NAVER_CLIENT_SECRET'),
    redirectUri: requiredRedirectUri(config, 'NAVER_REDIRECT_URI', NAVER_CALLBACK_PATH, '네이버'),
  };
}
