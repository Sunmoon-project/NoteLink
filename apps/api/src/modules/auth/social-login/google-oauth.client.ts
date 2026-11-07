import { Inject, Injectable } from '@nestjs/common';

import type { GoogleConfig } from '../../../config/google.config.js';
import { GOOGLE_CONFIG } from './social-login.constants.js';
import { type SocialProfile, SocialProviderError } from './social-provider.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

/** 구글이 이 시간 안에 답하지 않으면 포기한다(로그인 화면이 멈춘 채 기다리지 않게) */
const REQUEST_TIMEOUT_MS = 5_000;

type Json = Record<string, unknown>;

/** 구글과 직접 통신해 콜백으로 받은 코드를 사용자 정보로 바꾼다 */
@Injectable()
export class GoogleOAuthClient {
  constructor(@Inject(GOOGLE_CONFIG) private readonly config: GoogleConfig) {}

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
    const body = await this.request(
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
    const body = await this.request(
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

  /** 구글에 요청을 보내고 JSON 본문을 돌려준다. 실패는 모두 SocialProviderError로 바꾼다 */
  private async request(
    url: string,
    init: RequestInit,
    what: string,
    invalidCodeStatus?: number,
  ): Promise<Json> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // 비밀값이 든 요청을 다른 주소로 따라가지 않는다
        redirect: 'error',
      });
    } catch {
      throw new SocialProviderError('unavailable', `구글 ${what} 요청에 실패했습니다`);
    }
    if (!res.ok) {
      const reason = res.status === invalidCodeStatus ? 'invalid_code' : 'unavailable';
      throw new SocialProviderError(reason, `구글 ${what} 응답 상태: ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SocialProviderError('unavailable', `구글 ${what} 응답을 읽지 못했습니다`);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new SocialProviderError('unavailable', `구글 ${what} 응답 형식이 올바르지 않습니다`);
    }
    return body as Json;
  }
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/** 이메일은 users.email 규칙(소문자 · 공백 제거)에 맞춘다 */
function cleanEmail(value: unknown): string | null {
  const email = cleanText(value);
  return email === null ? null : email.toLowerCase();
}
