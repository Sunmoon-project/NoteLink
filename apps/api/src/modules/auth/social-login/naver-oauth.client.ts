import { Inject, Injectable } from '@nestjs/common';

import type { NaverConfig } from '../../../config/naver.config.js';
import { buildNaverAuthUrl } from './naver-auth-url.js';
import { cleanText, type Json, requestJson, safeIdentifier } from './provider-http.js';
import { NAVER_CONFIG } from './social-login.constants.js';
import {
  type SocialProfile,
  type SocialProviderAdapter,
  type SocialProviderContext,
  SocialProviderError,
} from './social-provider.js';

const TOKEN_ENDPOINT = 'https://nid.naver.com/oauth2.0/token';
const PROFILE_ENDPOINT = 'https://openapi.naver.com/v1/nid/me';

/** 네이버가 사용자 정보 조회에 성공했을 때 돌려주는 resultcode */
const RESULT_OK = '00';

/** 토큰 교환 오류 중 사용자의 코드 · state 문제로 보는 값. 그 밖의 오류(invalid_client 등)는 우리 설정 문제다 */
const INVALID_CODE_ERRORS = new Set(['invalid_request', 'invalid_grant', 'access_denied']);

/** 네이버와 직접 통신해 콜백으로 받은 코드를 사용자 정보로 바꾼다 */
@Injectable()
export class NaverOAuthClient implements SocialProviderAdapter {
  readonly name = 'naver' as const;

  constructor(@Inject(NAVER_CONFIG) private readonly config: NaverConfig) {}

  buildAuthUrl(oauthState: string): string {
    return buildNaverAuthUrl(this.config, oauthState);
  }

  /**
   * 코드를 access 토큰으로 교환하고, 그 토큰으로 사용자 정보를 가져온다.
   * 네이버는 토큰 교환에 인가 요청 때 보낸 `state`를 다시 요구한다.
   * 이메일은 인증 여부를 알 수 없어 저장하지 않는다(항상 null). 계정 중복 확인의 기준으로 믿을 수 없기 때문이다.
   * @throws SocialProviderError 코드가 잘못됐으면 `invalid_code`, 그 밖의 실패는 `unavailable`
   */
  async fetchProfile(code: string, context: SocialProviderContext): Promise<SocialProfile> {
    if (code === '')
      throw new SocialProviderError('invalid_code', '네이버 인증 코드가 비어 있습니다');
    const accessToken = await this.exchangeCode(code, context.oauthState);
    return this.fetchUser(accessToken);
  }

  private async exchangeCode(code: string, oauthState: string): Promise<string> {
    const body = await requestJson(
      '네이버',
      TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          state: oauthState,
        }),
      },
      '코드 교환',
      // 네이버는 코드가 잘못돼도 200에 error를 담아 보낼 수 있어, 상태 코드와 별개로 본문의 error도 본다
      400,
    );
    throwIfErrorBody(body, '코드 교환');
    const accessToken = body['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new SocialProviderError(
        'unavailable',
        '네이버 코드 교환 응답에 access_token이 없습니다',
      );
    }
    return accessToken;
  }

  private async fetchUser(accessToken: string): Promise<SocialProfile> {
    const body = await requestJson(
      '네이버',
      PROFILE_ENDPOINT,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      '사용자 정보 조회',
    );
    if (body['resultcode'] !== RESULT_OK) {
      const code = safeIdentifier(body['resultcode']);
      throw new SocialProviderError(
        'unavailable',
        `네이버 사용자 정보 조회 결과가 성공이 아닙니다${code ? ` (resultcode ${code})` : ''}`,
      );
    }
    const profile = asObject(body['response']);
    const id = profile['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new SocialProviderError('unavailable', '네이버 사용자 정보에 id가 없습니다');
    }
    return {
      // 네이버의 id는 계정에 1:1로 묶인 이용자 식별자(계정 아이디가 아니다)
      providerUid: id,
      email: null,
      // 실명(name)이 아니라 프로필 별명(nickname)만 닉네임 초기값으로 쓴다
      name: cleanText(profile['nickname']),
    };
  }
}

/** 200 응답에 `error`가 있으면 실패다. 오류 식별자만 문구에 남긴다(error_description은 읽지 않는다) */
function throwIfErrorBody(body: Json, what: string): void {
  if (body['error'] === undefined) return;
  const error = safeIdentifier(body['error']);
  const reason = INVALID_CODE_ERRORS.has(error) ? 'invalid_code' : 'unavailable';
  throw new SocialProviderError(
    reason,
    `네이버 ${what} 응답에 오류가 있습니다${error ? ` (${error})` : ''}`,
  );
}

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}
