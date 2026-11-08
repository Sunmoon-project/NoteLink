import { describe, expect, it, vi } from 'vitest';

import { generateNumericCode, NUMERIC_CODE_MAX_LENGTH } from '../src/common/numeric-code.js';

describe('generateNumericCode', () => {
  describe('모양', () => {
    it.each([1, 4, 6, 8, 14])('%i자리를 요청하면 정확히 그 자릿수의 숫자 문자열이다', (length) => {
      const code = generateNumericCode(length);

      expect(code).toMatch(new RegExp(`^\\d{${length}}$`));
    });

    it('숫자가 아니라 문자열로 돌려준다', () => {
      expect(typeof generateNumericCode(6)).toBe('string');
    });

    it('앞자리가 0이어도 자릿수를 유지한다 (숫자로 바꾸면 사라지는 앞의 0)', () => {
      expect(generateNumericCode(6, () => 42)).toBe('000042');
      expect(generateNumericCode(6, () => 0)).toBe('000000');
      expect(generateNumericCode(6, () => 1)).toBe('000001');
    });

    it('가장 큰 값도 자릿수를 넘지 않는다', () => {
      expect(generateNumericCode(6, (max) => max - 1)).toBe('999999');
      expect(generateNumericCode(1, (max) => max - 1)).toBe('9');
    });

    it('14자리의 가장 큰 값도 정확하다 (정밀도 손실이 없다)', () => {
      expect(generateNumericCode(14, (max) => max - 1)).toBe('99999999999999');
    });
  });

  describe('난수 범위', () => {
    it('난수 함수에는 10의 자릿수제곱을 상한으로 넘긴다', () => {
      const seen: number[] = [];
      generateNumericCode(6, (max) => (seen.push(max), 0));
      generateNumericCode(3, (max) => (seen.push(max), 0));

      expect(seen).toEqual([1_000_000, 1_000]);
    });

    it('호출당 난수를 한 번만 뽑는다', () => {
      let calls = 0;
      generateNumericCode(6, () => (calls++, 7));

      expect(calls).toBe(1);
    });
  });

  describe('실제 난수', () => {
    it('여러 번 뽑으면 다양한 값이 나온다 (고정값이 아니다)', () => {
      const codes = new Set(Array.from({ length: 200 }, () => generateNumericCode(6)));

      expect(codes.size).toBeGreaterThan(190);
    });

    it('앞자리가 0인 값도 실제로 나온다 (약 10%)', () => {
      const codes = Array.from({ length: 2000 }, () => generateNumericCode(6));
      const zeroLeading = codes.filter((c) => c.startsWith('0')).length;

      expect(zeroLeading).toBeGreaterThan(100);
      expect(zeroLeading).toBeLessThan(300);
      expect(codes.every((c) => c.length === 6)).toBe(true);
    });

    it('각 자리에 0~9가 고르게 나온다 (한 자리가 치우치지 않는다)', () => {
      const counts = Array.from({ length: 6 }, () => new Array<number>(10).fill(0));
      for (let i = 0; i < 5000; i++) {
        [...generateNumericCode(6)].forEach((digit, pos) => counts[pos]![Number(digit)]!++);
      }

      for (const position of counts) {
        for (const count of position) {
          // 기대값 500, 매우 넉넉한 허용 범위(편향을 크게 잡아내는 용도)
          expect(count).toBeGreaterThan(350);
          expect(count).toBeLessThan(650);
        }
      }
    });
  });

  describe('잘못된 자릿수', () => {
    it.each([
      ['0', 0],
      ['음수', -1],
      ['소수', 6.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['15자리(범위 초과)', NUMERIC_CODE_MAX_LENGTH + 1],
      ['아주 큰 값', 100],
    ])('자릿수가 %s이면 RangeError이다', (_reason, length) => {
      expect(() => generateNumericCode(length)).toThrow(RangeError);
    });

    it('자릿수가 잘못되면 난수 함수를 부르지 않는다', () => {
      let calls = 0;

      expect(() => generateNumericCode(0, () => (calls++, 0))).toThrow(RangeError);
      expect(calls).toBe(0);
    });

    it('최대 자릿수는 14이다 (crypto.randomInt의 범위 한계 2^48 안에 들어오는 최대)', () => {
      expect(NUMERIC_CODE_MAX_LENGTH).toBe(14);
      expect(10 ** 14).toBeLessThan(2 ** 48);
      expect(10 ** 15).toBeGreaterThan(2 ** 48);
      expect(() => generateNumericCode(14)).not.toThrow();
    });
  });

  describe('범위를 벗어난 난수 함수를 믿지 않는다', () => {
    it.each([
      ['상한과 같은 값', (max: number) => max],
      ['상한을 넘는 값', (max: number) => max + 5],
      ['음수', () => -1],
      ['소수', () => 1.5],
      ['NaN', () => Number.NaN],
    ])(
      '난수 함수가 %s을 돌려주면 RangeError이다 (자릿수가 어긋난 코드를 만들지 않는다)',
      (_r, random) => {
        expect(() => generateNumericCode(6, random)).toThrow(RangeError);
      },
    );

    it('상한 바로 아래 값과 0은 허용한다 (경계)', () => {
      expect(() => generateNumericCode(6, (max) => max - 1)).not.toThrow();
      expect(() => generateNumericCode(6, () => 0)).not.toThrow();
    });
  });
});

// 인증번호는 예측할 수 없어야 한다. Math.random은 통계적으로는 균등해 보여도 예측이 가능하므로,
// 분포 검사로는 구별되지 않는다. 기본 난수가 암호학적 난수(crypto.randomInt)인지를 직접 확인한다.
describe('기본 난수는 crypto.randomInt를 쓴다', () => {
  it('node:crypto의 randomInt를 (0, 10^자릿수)로 호출한다', async () => {
    vi.resetModules();
    const randomInt = vi.fn(() => 31337);
    vi.doMock('node:crypto', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:crypto')>()),
      randomInt,
    }));
    const { generateNumericCode: fresh } = await import('../src/common/numeric-code.js');

    const code = fresh(6);

    expect(randomInt).toHaveBeenCalledExactlyOnceWith(0, 1_000_000);
    expect(code).toBe('031337');
    vi.doUnmock('node:crypto');
    vi.resetModules();
  });

  it('Math.random을 쓰지 않는다', async () => {
    const spy = vi.spyOn(Math, 'random');

    generateNumericCode(6);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
