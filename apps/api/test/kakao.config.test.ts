import { describe, expect, it } from 'vitest';

import { createKakaoConfig, KAKAO_CALLBACK_PATH } from '../src/config/kakao.config.js';
import type { ConfigReader } from '../src/config/mongo.config.js';

const VALID: Record<string, string | undefined> = {
  KAKAO_REST_API_KEY: 'test-rest-api-key',
  KAKAO_CLIENT_SECRET: 'test-client-secret',
  KAKAO_REDIRECT_URI: `http://localhost:3000${KAKAO_CALLBACK_PATH}`,
};

/** 정상 값에서 일부만 바꾼 가짜 설정 -> undefined를 주면 그 변수가 없는 상태가 된다. */
function configOf(overrides: Record<string, string | undefined> = {}): ConfigReader {
  const values = { ...VALID, ...overrides };
  return { get: (key) => values[key] };
}

describe('createKakaoConfig', () => {
  it('정상 값을 설정 객체로 만든다', () => {
    expect(createKakaoConfig(configOf())).toEqual({
      restApiKey: 'test-rest-api-key',
      clientSecret: 'test-client-secret',
      redirectUri: `http://localhost:3000${KAKAO_CALLBACK_PATH}`,
    });
  });

  it('값 앞뒤 공백은 지운다', () => {
    const config = createKakaoConfig(
      configOf({
        KAKAO_REST_API_KEY: '  test-rest-api-key\n',
        KAKAO_CLIENT_SECRET: ' test-client-secret ',
        KAKAO_REDIRECT_URI: ` http://localhost:3000${KAKAO_CALLBACK_PATH} `,
      }),
    );

    expect(config).toEqual({
      restApiKey: 'test-rest-api-key',
      clientSecret: 'test-client-secret',
      redirectUri: `http://localhost:3000${KAKAO_CALLBACK_PATH}`,
    });
  });

  it('콜백 경로는 컨트롤러의 `:provider/callback` 과 같은 모양이다', () => {
    expect(KAKAO_CALLBACK_PATH).toBe('/api/v1/auth/social/kakao/callback');
  });

  describe.each(Object.keys(VALID))('%s', (key) => {
    it('없으면 실패한다', () => {
      expect(() => createKakaoConfig(configOf({ [key]: undefined }))).toThrow(key);
    });

    it('공백뿐이면 실패한다', () => {
      expect(() => createKakaoConfig(configOf({ [key]: '   ' }))).toThrow(key);
    });
  });

  describe('리다이렉트 주소(KAKAO_REDIRECT_URI)', () => {
    it.each([
      `http://localhost:3000${KAKAO_CALLBACK_PATH}`,
      `http://127.0.0.1:3000${KAKAO_CALLBACK_PATH}`,
      `https://notelink.app${KAKAO_CALLBACK_PATH}`,
      `https://notelink.app:8443${KAKAO_CALLBACK_PATH}`,
    ])('%s는 허용한다', (uri) => {
      expect(createKakaoConfig(configOf({ KAKAO_REDIRECT_URI: uri })).redirectUri).toBe(uri);
    });

    it.each([
      ['운영 주소가 http', `http://notelink.app${KAKAO_CALLBACK_PATH}`],
      ['/api/v1 접두사 없음', 'https://notelink.app/auth/social/kakao/callback'],
      ['다른 제공자의 콜백 경로', 'https://notelink.app/api/v1/auth/social/google/callback'],
      ['경로 끝에 /', `https://notelink.app${KAKAO_CALLBACK_PATH}/`],
      ['쿼리가 붙음', `https://notelink.app${KAKAO_CALLBACK_PATH}?a=1`],
      ['해시가 붙음', `https://notelink.app${KAKAO_CALLBACK_PATH}#top`],
      ['경로 없음', 'https://notelink.app'],
      ['주소가 아님', 'not a url'],
      ['호스트가 대문자', `HTTPS://NOTELINK.APP${KAKAO_CALLBACK_PATH}`],
      ['기본 포트 :443이 붙음', `https://notelink.app:443${KAKAO_CALLBACK_PATH}`],
    ])('%s이면 거부한다', (_reason, uri) => {
      expect(() => createKakaoConfig(configOf({ KAKAO_REDIRECT_URI: uri }))).toThrow(
        'KAKAO_REDIRECT_URI',
      );
    });

    it('글자가 달라지는 경우의 안내 문구에 카카오를 안내한다', () => {
      expect(() =>
        createKakaoConfig(
          configOf({ KAKAO_REDIRECT_URI: `https://notelink.app:443${KAKAO_CALLBACK_PATH}` }),
        ),
      ).toThrow('카카오에 등록한 주소');
    });
  });

  it('구글 환경변수 이름과 섞이지 않는다 (GOOGLE_*만 있어도 카카오 설정은 만들어지지 않는다)', () => {
    const only = { get: (key: string) => (key.startsWith('GOOGLE_') ? 'x' : undefined) };

    expect(() => createKakaoConfig(only)).toThrow('KAKAO_REST_API_KEY');
  });

  it('오류 문구에 시크릿 값을 넣지 않는다', () => {
    const secret = 'super-secret-value-do-not-leak';
    let message = '';
    try {
      createKakaoConfig(configOf({ KAKAO_CLIENT_SECRET: secret, KAKAO_REDIRECT_URI: 'not a url' }));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('KAKAO_REDIRECT_URI');
    expect(message).not.toContain(secret);
  });
});
