import { describe, expect, it } from 'vitest';

import { createGoogleConfig, GOOGLE_CALLBACK_PATH } from '../src/config/google.config.js';
import type { ConfigReader } from '../src/config/mongo.config.js';

const VALID: Record<string, string | undefined> = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: `http://localhost:3000${GOOGLE_CALLBACK_PATH}`,
};

/** 정상 값에서 일부만 바꾼 가짜 설정 -> undefined를 주면 그 변수가 없는 상태가 된다. */
function configOf(overrides: Record<string, string | undefined> = {}): ConfigReader {
  const values = { ...VALID, ...overrides };
  return { get: (key) => values[key] };
}

describe('createGoogleConfig', () => {
  it('정상 값을 설정 객체로 만든다', () => {
    expect(createGoogleConfig(configOf())).toEqual({
      clientId: 'test-client-id.apps.googleusercontent.com',
      clientSecret: 'test-client-secret',
      redirectUri: `http://localhost:3000${GOOGLE_CALLBACK_PATH}`,
    });
  });

  it('값 앞뒤 공백은 지운다', () => {
    const config = createGoogleConfig(
      configOf({
        GOOGLE_CLIENT_ID: '  test-client-id.apps.googleusercontent.com\n',
        GOOGLE_CLIENT_SECRET: ' test-client-secret ',
        GOOGLE_REDIRECT_URI: ` http://localhost:3000${GOOGLE_CALLBACK_PATH} `,
      }),
    );

    expect(config).toEqual({
      clientId: 'test-client-id.apps.googleusercontent.com',
      clientSecret: 'test-client-secret',
      redirectUri: `http://localhost:3000${GOOGLE_CALLBACK_PATH}`,
    });
  });

  describe.each(Object.keys(VALID))('%s', (key) => {
    it('없으면 실패한다', () => {
      expect(() => createGoogleConfig(configOf({ [key]: undefined }))).toThrow(key);
    });

    it('공백뿐이면 실패한다', () => {
      expect(() => createGoogleConfig(configOf({ [key]: '   ' }))).toThrow(key);
    });
  });

  describe('리디렉션 주소(GOOGLE_REDIRECT_URI)', () => {
    // 구글은 localhost만 http를 허용하고, 그 밖의 주소는 https여야 한다
    it.each([
      `http://localhost:3000${GOOGLE_CALLBACK_PATH}`,
      `http://127.0.0.1:3000${GOOGLE_CALLBACK_PATH}`,
      `https://notelink.app${GOOGLE_CALLBACK_PATH}`,
      `https://notelink.app:8443${GOOGLE_CALLBACK_PATH}`, // 기본 포트가 아니면 생략하지 않는다
    ])('%s는 허용한다', (uri) => {
      expect(createGoogleConfig(configOf({ GOOGLE_REDIRECT_URI: uri })).redirectUri).toBe(uri);
    });

    it.each([
      ['운영 주소가 http', `http://notelink.app${GOOGLE_CALLBACK_PATH}`],
      ['http · https가 아닌 프로토콜', `ftp://notelink.app${GOOGLE_CALLBACK_PATH}`],
      ['/api/v1 접두사 없음', 'https://notelink.app/auth/social/google/callback'],
      ['다른 제공자의 콜백 경로', 'https://notelink.app/api/v1/auth/social/kakao/callback'],
      ['경로 끝에 /', `https://notelink.app${GOOGLE_CALLBACK_PATH}/`],
      ['쿼리가 붙음', `https://notelink.app${GOOGLE_CALLBACK_PATH}?a=1`],
      ['해시가 붙음', `https://notelink.app${GOOGLE_CALLBACK_PATH}#top`],
      ['끝에 빈 ?만 붙음', `https://notelink.app${GOOGLE_CALLBACK_PATH}?`],
      ['끝에 빈 #만 붙음', `https://notelink.app${GOOGLE_CALLBACK_PATH}#`],
      ['경로 없음', 'https://notelink.app'],
      ['주소가 아님', 'not a url'],
      // URL이 정규화해 버려 구글에 등록한 글자와 달라지는 경우
      ['호스트가 대문자', `HTTPS://NOTELINK.APP${GOOGLE_CALLBACK_PATH}`],
      ['기본 포트 :443이 붙음', `https://notelink.app:443${GOOGLE_CALLBACK_PATH}`],
      ['localhost에 기본 포트 :80이 붙음', `http://localhost:80${GOOGLE_CALLBACK_PATH}`],
    ])('%s이면 거부한다', (_reason, uri) => {
      expect(() => createGoogleConfig(configOf({ GOOGLE_REDIRECT_URI: uri }))).toThrow(
        'GOOGLE_REDIRECT_URI',
      );
    });
  });

  it('오류 문구에 시크릿 값을 넣지 않는다', () => {
    const secret = 'super-secret-value-do-not-leak';
    let message = '';
    try {
      createGoogleConfig(
        configOf({ GOOGLE_CLIENT_SECRET: secret, GOOGLE_REDIRECT_URI: 'not a url' }),
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('GOOGLE_REDIRECT_URI');
    expect(message).not.toContain(secret);
  });
});
