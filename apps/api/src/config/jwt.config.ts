import type { JwtSignOptions } from '@nestjs/jwt';
import type { ConfigReader } from './mongo.config.js';

//  '15m', '14d' 같은 만료 시간 형식 (@nestjs/jwt가 받는 타입과 같다)
type TTL = NonNullable<JwtSignOptions['expiresIn']>;

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTTL: TTL;
  refreshTTL: TTL;
}

const MIN_SECRET_LENGTH = 32;
// 숫자 + 단위(ms s m h d w y). "900"처럼 단위가 없는 값은 밀리초로 읽혀 15분이 0.9초가 되는걸 방지
const TTL_PATTERN = /^[1-9]\d*(ms|s|m|h|d|w|y)$/;

function required(config: ConfigReader, key: string): string {
  const value = config.get(key)?.trim();
  if (!value) {
    throw new Error(`${key} 환경변수가 필요합니다 (apps/api/.env.example 참고)`);
  }
  return value;
}

function secret(config: ConfigReader, key: string): string {
  const value = required(config, key);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${key}는 ${MIN_SECRET_LENGTH}자 이상이어야 합니다`);
  }
  return value;
}

function ttl(config: ConfigReader, key: string): TTL {
  const value = required(config, key);
  if (!TTL_PATTERN.test(value)) {
    throw new Error(`${key} 형식이 올바르지 않습니다 (예: 15m 14d)`);
  }
  return value as TTL;
}

export function createJwtConfig(config: ConfigReader): JwtConfig {
  const accessSecret = secret(config, 'JWT_ACCESS_SECRET');
  const refreshSecret = secret(config, 'JWT_REFRESH_SECRET');
  if (accessSecret === refreshSecret) {
    throw new Error(`JWT_ACCESS_SECRET과 JWT_REFRESH_SECRET의 값은 달라야 합니다.`);
  }
  return {
    accessSecret,
    refreshSecret,
    accessTTL: ttl(config, 'JWT_ACCESS_TTL'),
    refreshTTL: ttl(config, 'JWT_REFRESH_TTL'),
  };
}
