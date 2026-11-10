import type { ConfigReader } from './mongo.config.js';

/** 소셜 로그인 제공자 설정(구글 · 카카오 · 네이버)이 같이 쓰는 환경변수 검증 */

export function requiredEnv(config: ConfigReader, key: string): string {
  const value = config.get(key)?.trim();
  if (!value) {
    throw new Error(`${key} 환경변수가 필요합니다 (apps/api/.env.production 참고)`);
  }
  return value;
}

/**
 * 제공자 콘솔에 등록한 리디렉션 주소를 검증한다.
 * @param providerLabel 오류 문구에 쓰는 제공자 이름(예: 구글)
 * @param callbackPath 컨트롤러의 실제 콜백 경로. 주소의 경로가 이것과 같아야 한다
 */
export function requiredRedirectUri(
  config: ConfigReader,
  key: string,
  callbackPath: string,
  providerLabel: string,
): string {
  const value = requiredEnv(config, key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key}는 올바른 주소여야 합니다`);
  }
  // 제공자는 localhost만 http를 허용하고 나머지는 https만 허용한다
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${key}는 https 주소여야 합니다 (localhost만 http 허용)`);
  }
  // 제공자는 등록한 주소와 글자까지 같은 주소만 받는다. 쿼리 · 해시는 비어 있어도(끝의 ? · #) 글자가 달라지므로 문자열로 본다
  if (value.includes('?') || value.includes('#') || url.pathname !== callbackPath) {
    throw new Error(`${key}는 ${callbackPath} 로 끝나야 합니다 (쿼리 · 끝의 / 없음)`);
  }
  // 대문자 호스트(HTTPS://NOTELINK.APP), 기본 포트(:443 · :80), /./ 같은 경로는 URL이 정규화해 버려 등록한 글자와 달라진다
  if (url.href !== value) {
    throw new Error(
      `${key}는 ${providerLabel}에 등록한 주소와 글자까지 같아야 합니다 (소문자 호스트, 기본 포트 생략)`,
    );
  }
  return value;
}
