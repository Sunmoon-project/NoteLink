/** 앱의 닉네임 규칙(apps/mobile/src/lib/validation.ts nicknameError): 한글 · 영문 · 숫자만, 2~10자 */
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 10;

const NOT_ALLOWED = /[^가-힣A-Za-z0-9]/g;
const FALLBACK_PREFIX = '사용자';

/**
 * 소셜 로그인으로 처음 온 사용자의 닉네임 초기값을 만든다. 사용자가 프로필 설정에서 바꿀 수 있다.
 * - 제공자가 준 이름에서 허용되지 않는 글자(공백 · 특수문자 · 이모지 등)를 빼고 10자까지만 쓴다
 * - 남은 글자가 2자 미만이면 `사용자` + 숫자로 대신한다
 * @param randomDigits 대체 닉네임에 붙일 숫자(테스트에서 고정할 수 있게 받는다)
 */
export function initialNickname(
  name: string | null,
  randomDigits: () => string = fourRandomDigits,
): string {
  const cleaned = (name ?? '').normalize('NFC').replace(NOT_ALLOWED, '');
  // 자르는 단위는 글자(코드 포인트)다. 한글은 조합형이 아니라 완성형(NFC)으로 맞춘 뒤 센다
  const clipped = Array.from(cleaned).slice(0, NICKNAME_MAX).join('');
  if (Array.from(clipped).length >= NICKNAME_MIN) return clipped;
  return `${FALLBACK_PREFIX}${randomDigits()}`;
}

function fourRandomDigits(): string {
  return String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
}
