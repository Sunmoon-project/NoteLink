import { describe, expect, it } from 'vitest';

import { createNaverConfig, NAVER_CALLBACK_PATH } from '../src/config/naver.config.js';
import type { ConfigReader } from '../src/config/mongo.config.js';

const VALID: Record<string, string | undefined> = {
  NAVER_CLIENT_ID: 'test-naver-client-id',
  NAVER_CLIENT_SECRET: 'test-client-secret',
  NAVER_REDIRECT_URI: `http://localhost:3000${NAVER_CALLBACK_PATH}`,
};

/** 정상 값에서 일부만 바꾼 가짜 설정 -> undefined를 주면 그 변수가 없는 상태가 된다. */
function configOf(overrides: Record<string, string | undefined> = {}): ConfigReader {
  const values = { ...VALID, ...overrides };
  return { get: (key) => values[key] };
}

describe('createNaverConfig', () => {
  it('정상 값을 설정 객체로 만든다', () => {
    expect(createNaverConfig(configOf())).toEqual({
      clientId: 'test-naver-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: `http://localhost:3000${NAVER_CALLBACK_PATH}`,
    });
  });

  it('값 앞뒤 공백은 지운다', () => {
    const config = createNaverConfig(
      configOf({
        NAVER_CLIENT_ID: '  test-naver-client-id\n',
        NAVER_CLIENT_SECRET: ' test-client-secret ',
        NAVER_REDIRECT_URI: ` http://localhost:3000${NAVER_CALLBACK_PATH} `,
      }),
    );

    expect(config).toEqual({
      clientId: 'test-naver-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: `http://localhost:3000${NAVER_CALLBACK_PATH}`,
    });
  });

  it('콜백 경로는 컨트롤러의 `:provider/callback` 과 같은 모양이다', () => {
    expect(NAVER_CALLBACK_PATH).toBe('/api/v1/auth/social/naver/callback');
  });

  describe.each(Object.keys(VALID))('%s', (key) => {
    it('없으면 실패한다', () => {
      expect(() => createNaverConfig(configOf({ [key]: undefined }))).toThrow(key);
    });

    it('공백뿐이면 실패한다', () => {
      expect(() => createNaverConfig(configOf({ [key]: '   ' }))).toThrow(key);
    });
  });

  describe('리다이렉트 주소(NAVER_REDIRECT_URI)', () => {
    it.each([
      `http://localhost:3000${NAVER_CALLBACK_PATH}`,
      `http://127.0.0.1:3000${NAVER_CALLBACK_PATH}`,
      `https://notelink.app${NAVER_CALLBACK_PATH}`,
      `https://notelink.app:8443${NAVER_CALLBACK_PATH}`,
    ])('%s는 허용한다', (uri) => {
      expect(createNaverConfig(configOf({ NAVER_REDIRECT_URI: uri })).redirectUri).toBe(uri);
    });

    it.each([
      ['운영 주소가 http', `http://notelink.app${NAVER_CALLBACK_PATH}`],
      ['/api/v1 접두사 없음', 'https://notelink.app/auth/social/naver/callback'],
      ['다른 제공자의 콜백 경로', 'https://notelink.app/api/v1/auth/social/google/callback'],
      ['경로 끝에 /', `https://notelink.app${NAVER_CALLBACK_PATH}/`],
      ['쿼리가 붙음', `https://notelink.app${NAVER_CALLBACK_PATH}?a=1`],
      ['해시가 붙음', `https://notelink.app${NAVER_CALLBACK_PATH}#top`],
      ['경로 없음', 'https://notelink.app'],
      ['주소가 아님', 'not a url'],
      ['호스트가 대문자', `HTTPS://NOTELINK.APP${NAVER_CALLBACK_PATH}`],
      ['기본 포트 :443이 붙음', `https://notelink.app:443${NAVER_CALLBACK_PATH}`],
    ])('%s이면 거부한다', (_reason, uri) => {
      expect(() => createNaverConfig(configOf({ NAVER_REDIRECT_URI: uri }))).toThrow(
        'NAVER_REDIRECT_URI',
      );
    });

    it('글자가 달라지는 경우의 안내 문구에 네이버를 안내한다', () => {
      expect(() =>
        createNaverConfig(
          configOf({ NAVER_REDIRECT_URI: `https://notelink.app:443${NAVER_CALLBACK_PATH}` }),
        ),
      ).toThrow('네이버에 등록한 주소');
    });
  });

  it('구글 환경변수 이름과 섞이지 않는다 (GOOGLE_*만 있어도 네이버 설정은 만들어지지 않는다)', () => {
    const only = { get: (key: string) => (key.startsWith('GOOGLE_') ? 'x' : undefined) };

    expect(() => createNaverConfig(only)).toThrow('NAVER_CLIENT_ID');
  });

  it('오류 문구에 시크릿 값을 넣지 않는다', () => {
    const secret = 'super-secret-value-do-not-leak';
    let message = '';
    try {
      createNaverConfig(configOf({ NAVER_CLIENT_SECRET: secret, NAVER_REDIRECT_URI: 'not a url' }));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('NAVER_REDIRECT_URI');
    expect(message).not.toContain(secret);
  });
});
