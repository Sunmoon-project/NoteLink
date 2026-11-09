import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createGoogleConfig } from '../src/config/google.config.js';
import { createJwtConfig } from '../src/config/jwt.config.js';
import { createKakaoConfig } from '../src/config/kakao.config.js';
import { createNaverConfig } from '../src/config/naver.config.js';
import { type ConfigReader, createMongooseOptions } from '../src/config/mongo.config.js';
import { createMailSender } from '../src/modules/mail/create-mail-sender.js';
import { SmtpMailSender } from '../src/modules/mail/smtp-mail-sender.js';

/** .env.production(배포 기준 예시)을 KEY=VALUE로 읽는다(주석 · 빈 줄 제외). 개발자가 이 파일을 복사해 .env로 쓴다 */
function readEnvExample(): ConfigReader {
  const text = readFileSync(new URL('../.env.production', import.meta.url), 'utf8');
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    values.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return { get: (key) => values.get(key) };
}

describe('.env.production', () => {
  it('그대로 복사해 쓰면 MongoDB 설정 검증을 통과한다', () => {
    expect(() => createMongooseOptions(readEnvExample())).not.toThrow();
  });

  it('그대로 복사해 쓰면 JWT 설정 검증을 통과한다', () => {
    expect(() => createJwtConfig(readEnvExample())).not.toThrow();
  });

  it('그대로 복사해 쓰면 구글 로그인 설정 검증을 통과한다', () => {
    expect(() => createGoogleConfig(readEnvExample())).not.toThrow();
  });

  it('그대로 복사해 쓰면 카카오 로그인 설정 검증을 통과한다', () => {
    expect(() => createKakaoConfig(readEnvExample())).not.toThrow();
  });

  it('그대로 복사해 쓰면 네이버 로그인 설정 검증을 통과한다', () => {
    expect(() => createNaverConfig(readEnvExample())).not.toThrow();
  });

  it('그대로 복사해 쓰면 메일(SMTP) 설정 검증을 통과한다 (접속은 하지 않는다)', () => {
    const sender = createMailSender(readEnvExample(), () => ({
      sendMail: () => Promise.resolve({}),
    }));

    expect(sender).toBeInstanceOf(SmtpMailSender);
  });

  it('PORT 예시가 있다', () => {
    expect(readEnvExample().get('PORT')).toMatch(/^\d+$/);
  });
});
