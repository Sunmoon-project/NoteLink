import { describe, expect, it } from 'vitest';

import { createJwtConfig } from '../src/config/jwt.config.js';
import type { ConfigReader } from '../src/config/mongo.config.js';

const VALID: Record<string, string | undefined> = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '14d',
};

/** 정상 값에서 일부만 바꾼 가짜 설정을 만든다. undefined를 주면 그 변수가 없는 상태가 된다 */
function configOf(overrides: Record<string, string | undefined> = {}): ConfigReader {
  const values = { ...VALID, ...overrides };
  return { get: (key) => values[key] };
}

describe('createJwtConfig', () => {
  it('정상 값을 설정 객체로 만든다', () => {
    expect(createJwtConfig(configOf())).toEqual({
      accessSecret: 'a'.repeat(32),
      refreshSecret: 'b'.repeat(32),
      accessTTL: '15m',
      refreshTTL: '14d',
    });
  });

  it('값 앞뒤 공백은 지운다', () => {
    const config = createJwtConfig(configOf({ JWT_ACCESS_TTL: ' 15m ' }));

    expect(config.accessTTL).toBe('15m');
  });

  describe.each(Object.keys(VALID))('%s', (key) => {
    it('없으면 실패한다', () => {
      expect(() => createJwtConfig(configOf({ [key]: undefined }))).toThrow(key);
    });

    it('공백뿐이면 실패한다', () => {
      expect(() => createJwtConfig(configOf({ [key]: '   ' }))).toThrow(key);
    });
  });

  describe('시크릿 길이', () => {
    it('31자는 거부한다', () => {
      expect(() => createJwtConfig(configOf({ JWT_ACCESS_SECRET: 'a'.repeat(31) }))).toThrow(
        'JWT_ACCESS_SECRET',
      );
    });

    it('32자는 허용한다', () => {
      expect(() => createJwtConfig(configOf({ JWT_ACCESS_SECRET: 'a'.repeat(32) }))).not.toThrow();
    });
  });

  it('access와 refresh 시크릿이 같으면 실패한다', () => {
    const same = 'c'.repeat(40);

    expect(() =>
      createJwtConfig(configOf({ JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same })),
    ).toThrow('달라야');
  });

  describe('만료 시간 형식', () => {
    it.each(['30s', '15m', '1h', '14d', '2w'])('%s는 허용한다', (ttl) => {
      expect(createJwtConfig(configOf({ JWT_ACCESS_TTL: ttl })).accessTTL).toBe(ttl);
    });

    // 900: 단위가 없으면 밀리초로 읽혀 0.9초 만에 만료된다
    it.each(['900', 'abc', '0m', '-5m', '15 m', '15M'])('%j는 거부한다', (ttl) => {
      expect(() => createJwtConfig(configOf({ JWT_ACCESS_TTL: ttl }))).toThrow('JWT_ACCESS_TTL');
      expect(() => createJwtConfig(configOf({ JWT_REFRESH_TTL: ttl }))).toThrow('JWT_REFRESH_TTL');
    });
  });

  it('오류 문구에 시크릿 값을 넣지 않는다', () => {
    const leaked = 'short-secret-value';
    let message = '';
    try {
      createJwtConfig(configOf({ JWT_ACCESS_SECRET: leaked }));
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).not.toContain(leaked);
  });
});
