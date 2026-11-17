import { randomInt } from 'node:crypto';

/** 0 이상 max 미만의 정수를 뽑는 함수. 시험에서는 값을 고정하려고 바꿔 끼운다 */
export type RandomInt = (max: number) => number;

/**
 * `crypto.randomInt`는 범위(max - min)가 2^48 미만이어야 한다.
 * 10^14 < 2^48 < 10^15 이므로 안전하게 만들 수 있는 자릿수는 최대 14자리다.
 */
export const NUMERIC_CODE_MAX_LENGTH = 14;

const defaultRandom: RandomInt = (max) => randomInt(0, max);

/**
 * 암호학적 난수로 `length`자리 숫자 문자열을 만든다. 앞자리가 0이어도 자릿수를 유지한다("000042").
 * 숫자로 바꿔 저장하거나 비교하면 앞의 0이 사라지므로 **문자열 그대로** 다뤄야 한다.
 *
 * 이 함수는 숫자를 뽑기만 한다. 저장 방식(해시 / 원문), 중복 검사, 수명, 시도 횟수 제한은
 * 쓰는 쪽의 책임이다(예: 이메일 인증번호는 해시만 저장하고, 방 입장 코드는 방에 원문을 저장하며 중복이면 다시 뽑는다).
 *
 * @param random 시험에서 값을 고정할 때만 넘긴다
 * @throws RangeError 자릿수가 1~14의 정수가 아니거나, 난수 함수가 범위를 벗어난 값을 돌려준 경우
 */
export function generateNumericCode(length: number, random: RandomInt = defaultRandom): string {
  if (!Number.isInteger(length) || length < 1 || length > NUMERIC_CODE_MAX_LENGTH) {
    throw new RangeError(`자릿수는 1~${NUMERIC_CODE_MAX_LENGTH}의 정수여야 합니다`);
  }
  const max = 10 ** length;
  const value = random(max);
  // 바꿔 끼운 난수 함수가 범위를 벗어나면 자릿수가 어긋난 코드가 조용히 만들어지므로 막는다
  if (!Number.isInteger(value) || value < 0 || value >= max) {
    throw new RangeError('난수가 범위를 벗어났습니다');
  }
  return value.toString().padStart(length, '0');
}
