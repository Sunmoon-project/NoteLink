import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createJwtConfig } from '../src/config/jwt.config.js';
import { type ConfigReader, createMongooseOptions } from '../src/config/mongo.config.js';

/** .env.example을 KEY=VALUE로 읽는다(주석 · 빈 줄 제외). 개발자가 이 파일을 복사해 .env로 쓴다 */
function readEnvExample(): ConfigReader {
  const text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    values.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return { get: (key) => values.get(key) };
}

describe('.env.example', () => {
  it('그대로 복사해 쓰면 MongoDB 설정 검증을 통과한다', () => {
    expect(() => createMongooseOptions(readEnvExample())).not.toThrow();
  });

  it('그대로 복사해 쓰면 JWT 설정 검증을 통과한다', () => {
    expect(() => createJwtConfig(readEnvExample())).not.toThrow();
  });

  it('PORT 예시가 있다', () => {
    expect(readEnvExample().get('PORT')).toMatch(/^\d+$/);
  });
});
