import { Inject, Injectable } from '@nestjs/common';

import type { KakaoConfig } from '../../../config/kakao.config.js';
import { buildKakaoAuthUrl } from './kakao-auth-url.js';
import { cleanEmail, cleanText, type Json, requestJson } from './provider-http.js';
import { KAKAO_CONFIG } from './social-login.constants.js';
import {
  type SocialProfile,
  type SocialProviderAdapter,
  SocialProviderError,
} from './social-provider.js';

const TOKEN_ENDPOINT = 'https://kauth.kakao.com/oauth/token';
const USER_ME_ENDPOINT = 'https://kapi.kakao.com/v2/user/me';

/** 카카오와 직접 통신해 콜백으로 받은 코드를 사용자 정보로 바꾼다 */
@Injectable()
export class KakaoOAuthClient implements SocialProviderAdapter {
  readonly name = 'kakao' as const;

  constructor(@Inject(KAKAO_CONFIG) private readonly config: KakaoConfig) {}

  buildAuthUrl(oauthState: string): string {
    return buildKakaoAuthUrl(this.config, oauthState);
  }

  /**
   * 코드를 access 토큰으로 교환하고, 그 토큰으로 사용자 정보를 가져온다.
   * @throws SocialProviderError 코드가 잘못됐으면 `invalid_code`, 그 밖의 실패는 `unavailable`
   */
  async fetchProfile(code: string): Promise<SocialProfile> {
    if (code === '')
      throw new SocialProviderError('invalid_code', '카카오 인증 코드가 비어 있습니다');
    const accessToken = await this.exchangeCode(code);
    return this.fetchUser(accessToken);
  }

  private async exchangeCode(code: string): Promise<string> {
    const body = await requestJson(
      '카카오',
      TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.restApiKey,
          client_secret: this.config.clientSecret,
          redirect_uri: this.config.redirectUri,
          code,
        }),
      },
      '코드 교환',
      // 400은 코드를 다시 쓰거나 만료된 경우(invalid_grant). 401 등은 우리 설정(키 · 시크릿) 문제다
      400,
    );
    const accessToken = body['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new SocialProviderError(
        'unavailable',
        '카카오 코드 교환 응답에 access_token이 없습니다',
      );
    }
    return accessToken;
  }

  private async fetchUser(accessToken: string): Promise<SocialProfile> {
    const body = await requestJson(
      '카카오',
      USER_ME_ENDPOINT,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      '사용자 정보 조회',
    );
    const account = asObject(body['kakao_account']);
    return {
      providerUid: readUserId(body['id']),
      email: readVerifiedEmail(account),
      name: cleanText(asObject(account['profile'])['nickname']),
    };
  }
}

/** 회원번호는 숫자(Long)로 온다. 정수로 안전하게 읽을 수 없으면(문자열 · 소수 · 너무 큰 값) 믿지 않는다 */
function readUserId(id: unknown): string {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new SocialProviderError('unavailable', '카카오 사용자 정보에 올바른 id가 없습니다');
  }
  return String(id);
}

/**
 * 카카오가 "유효하고 인증된 이메일"이라고 알려 준 경우에만 이메일을 쓴다.
 * 이메일 동의항목을 쓰지 않거나, 사용자가 동의하지 않았거나, 인증되지 않았으면 null이다(로그인은 이메일 없이도 된다).
 */
function readVerifiedEmail(account: Json): string | null {
  if (account['is_email_valid'] !== true || account['is_email_verified'] !== true) return null;
  return cleanEmail(account['email']);
}

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}
