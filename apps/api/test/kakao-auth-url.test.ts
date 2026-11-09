import { describe, expect, it } from 'vitest';

import { KAKAO_CALLBACK_PATH, type KakaoConfig } from '../src/config/kakao.config.js';
import { buildKakaoAuthUrl } from '../src/modules/auth/social-login/kakao-auth-url.js';

const CONFIG: KakaoConfig = {
  restApiKey: 'test-rest-api-key',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${KAKAO_CALLBACK_PATH}`,
};

function parse(oauthState = 'state-123') {
  return new URL(buildKakaoAuthUrl(CONFIG, oauthState));
}

describe('buildKakaoAuthUrl', () => {
  it('카카오의 인가 코드 요청 주소를 만든다', () => {
    const url = parse();

    expect(url.origin + url.pathname).toBe('https://kauth.kakao.com/oauth/authorize');
  });

  it('필요한 파라미터를 모두 담는다', () => {
    expect(Object.fromEntries(parse('state-123').searchParams)).toEqual({
      client_id: CONFIG.restApiKey,
      redirect_uri: CONFIG.redirectUri,
      response_type: 'code',
      state: 'state-123',
      prompt: 'select_account',
    });
  });

  it('scope는 보내지 않는다 (콘솔의 필수 동의항목이 동의 화면에 자동으로 나온다)', () => {
    expect(parse().searchParams.has('scope')).toBe(false);
  });

  it('서버가 등록한 리다이렉트 주소를 그대로 보낸다 (카카오 콘솔에 등록한 값과 같아야 한다)', () => {
    expect(parse().searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('client_secret은 주소에 넣지 않는다', () => {
    const href = buildKakaoAuthUrl(CONFIG, 'state-123');

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

  it('state가 다르면 주소도 다르다', () => {
    expect(buildKakaoAuthUrl(CONFIG, 'a')).not.toBe(buildKakaoAuthUrl(CONFIG, 'b'));
  });
});
