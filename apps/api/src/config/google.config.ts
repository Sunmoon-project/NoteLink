import type { ConfigReader } from './mongo.config.js';
import { requiredEnv, requiredRedirectUri } from './oauth-config.js';

/** 구글이 로그인 후 사용자를 돌려보낼 서버 주소의 경로. 컨트롤러의 실제 경로와 같아야 한다 */
export const GOOGLE_CALLBACK_PATH = '/api/v1/auth/social/google/callback';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createGoogleConfig(config: ConfigReader): GoogleConfig {
  return {
    clientId: requiredEnv(config, 'GOOGLE_CLIENT_ID'),
    clientSecret: requiredEnv(config, 'GOOGLE_CLIENT_SECRET'),
    redirectUri: requiredRedirectUri(config, 'GOOGLE_REDIRECT_URI', GOOGLE_CALLBACK_PATH, '구글'),
  };
}
