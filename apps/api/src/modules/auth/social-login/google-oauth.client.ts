import { Inject, Injectable } from '@nestjs/common';

import type { GoogleConfig } from '../../../config/google.config.js';
import { GOOGLE_CONFIG } from './social-login.constants.js';
import { buildGoogleAuthUrl } from './google-auth-url.js';
import { cleanEmail, cleanText, requestJson } from './provider-http.js';
import {
  type SocialProfile,
  type SocialProviderAdapter,
  SocialProviderError,
} from './social-provider.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** 구글과 직접 통신해 콜백으로 받은 코드를 사용자 정보로 바꾼다 */
@Injectable()
export class GoogleOAuthClient implements SocialProviderAdapter {
  readonly name = 'google' as const;

  constructor(@Inject(GOOGLE_CONFIG) private readonly config: GoogleConfig) {}

  buildAuthUrl(oauthState: string): string {
    return buildGoogleAuthUrl(this.config, oauthState);
  }

  /**
   * 코드를 access 토큰으로 교환하고, 그 토큰으로 사용자 정보를 가져온다.
   * @throws SocialProviderError 코드가 잘못됐으면 `invalid_code`, 그 밖의 실패는 `unavailable`
   */
  async fetchProfile(code: string): Promise<SocialProfile> {
    if (code === '')
      throw new SocialProviderError('invalid_code', '구글 인증 코드가 비어 있습니다');
    const accessToken = await this.exchangeCode(code);
    return this.fetchUserInfo(accessToken);
  }

  private async exchangeCode(code: string): Promise<string> {
    const body = await requestJson(
      '구글',
      TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          grant_type: 'authorization_code',
        }),
      },
      '코드 교환',
      // 400은 코드를 다시 쓰거나 만료된 경우(invalid_grant). 401 등은 우리 설정(client_id · secret) 문제다
      400,
    );
    const accessToken = body['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new SocialProviderError('unavailable', '구글 코드 교환 응답에 access_token이 없습니다');
    }
    return accessToken;
  }

  private async fetchUserInfo(accessToken: string): Promise<SocialProfile> {
    const body = await requestJson(
      '구글',
      USERINFO_ENDPOINT,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      '사용자 정보 조회',
    );
    const sub = body['sub'];
    if (typeof sub !== 'string' || sub.trim() === '') {
      throw new SocialProviderError('unavailable', '구글 사용자 정보에 sub가 없습니다');
    }
    return {
      providerUid: sub,
      // email_verified가 정확히 true일 때만 믿는다(문자열 "true"나 값이 없는 경우는 인증된 이메일이 아니다)
      email: body['email_verified'] === true ? cleanEmail(body['email']) : null,
      name: cleanText(body['name']),
    };
  }
}
