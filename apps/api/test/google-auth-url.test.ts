import { describe, expect, it } from 'vitest';

import { GOOGLE_CALLBACK_PATH, type GoogleConfig } from '../src/config/google.config.js';
import {
  buildGoogleAuthUrl,
  GOOGLE_SCOPE,
} from '../src/modules/auth/social-login/google-auth-url.js';

const CONFIG: GoogleConfig = {
  clientId: 'test-client-id.apps.googleusercontent.com',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${GOOGLE_CALLBACK_PATH}`,
};

function parse(oauthState = 'state-123') {
  return new URL(buildGoogleAuthUrl(CONFIG, oauthState));
}

describe('buildGoogleAuthUrl', () => {
  it('구글의 OAuth 로그인 주소를 만든다', () => {
    const url = parse();

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('필요한 파라미터를 모두 담는다', () => {
    const params = parse('state-123').searchParams;

    expect(Object.fromEntries(params)).toEqual({
      client_id: CONFIG.clientId,
      redirect_uri: CONFIG.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: 'state-123',
      prompt: 'select_account',
    });
  });

  it('요청 범위는 사용자 식별번호 · 이메일 · 이름이다', () => {
    expect(GOOGLE_SCOPE).toBe('openid email profile');
  });

  it('서버가 등록한 리디렉션 주소를 그대로 보낸다 (구글 콘솔에 등록한 값과 같아야 한다)', () => {
    expect(parse().searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('client_secret은 주소에 넣지 않는다', () => {
    const href = buildGoogleAuthUrl(CONFIG, 'state-123');

    expect(href).not.toContain(CONFIG.clientSecret);
    expect(href).not.toContain('client_secret');
  });

  it('특수문자는 주소 규칙에 맞게 인코딩한다 (파라미터가 새어 나가지 않는다)', () => {
    const state = 'a&redirect_uri=https://evil.example#x=1 y';
    const url = parse(state);

    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(url.searchParams.getAll('redirect_uri')).toHaveLength(1);
    expect(url.hash).toBe('');
  });

  it('서버가 만드는 state(base64url)는 그대로 보존된다', () => {
    const state = 'Ab09-_Ab09-_Ab09-_Ab09-_Ab09-_Ab09-_Ab09-_Ab09-_AA';

    expect(parse(state).searchParams.get('state')).toBe(state);
  });

  it('같은 입력이면 같은 주소를 만든다', () => {
    expect(buildGoogleAuthUrl(CONFIG, 's')).toBe(buildGoogleAuthUrl(CONFIG, 's'));
  });

  it('state가 다르면 주소도 다르다', () => {
    expect(buildGoogleAuthUrl(CONFIG, 'a')).not.toBe(buildGoogleAuthUrl(CONFIG, 'b'));
  });
});
