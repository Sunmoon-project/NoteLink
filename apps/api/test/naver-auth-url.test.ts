import { describe, expect, it } from 'vitest';

import { NAVER_CALLBACK_PATH, type NaverConfig } from '../src/config/naver.config.js';
import { buildNaverAuthUrl } from '../src/modules/auth/social-login/naver-auth-url.js';

const CONFIG: NaverConfig = {
  clientId: 'test-naver-client-id',
  clientSecret: 'super-secret-value-do-not-leak',
  redirectUri: `https://notelink.app${NAVER_CALLBACK_PATH}`,
};

function parse(oauthState = 'state-123') {
  return new URL(buildNaverAuthUrl(CONFIG, oauthState));
}

describe('buildNaverAuthUrl', () => {
  it('네이버의 인가 코드 요청 주소를 만든다', () => {
    const url = parse();

    expect(url.origin + url.pathname).toBe('https://nid.naver.com/oauth2.0/authorize');
  });

  it('필요한 파라미터를 모두 담는다', () => {
    expect(Object.fromEntries(parse('state-123').searchParams)).toEqual({
      response_type: 'code',
      client_id: CONFIG.clientId,
      redirect_uri: CONFIG.redirectUri,
      state: 'state-123',
    });
  });

  it('scope는 보내지 않는다 (네이버는 콘솔의 "제공 정보 선택"이 동의 화면에 나온다)', () => {
    expect(parse().searchParams.has('scope')).toBe(false);
  });

  it('state는 반드시 담는다 (네이버는 토큰 교환 때 같은 값을 다시 요구한다)', () => {
    expect(parse('abc').searchParams.get('state')).toBe('abc');
  });

  it('서버가 등록한 리다이렉트 주소를 그대로 보낸다 (네이버 개발자센터의 Callback URL과 같아야 한다)', () => {
    expect(parse().searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('client_secret은 주소에 넣지 않는다', () => {
    const href = buildNaverAuthUrl(CONFIG, 'state-123');

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
    expect(buildNaverAuthUrl(CONFIG, 'a')).not.toBe(buildNaverAuthUrl(CONFIG, 'b'));
  });
});
