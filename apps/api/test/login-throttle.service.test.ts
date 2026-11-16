import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOGIN_LOCK_MS,
  LOGIN_MAX_ATTEMPTS,
  LoginThrottleService,
} from '../src/modules/auth/app-login/login-throttle.service.js';
import { createFakeLoginAttempts } from './support/fake-login-attempts.js';

const EMAIL = 'student@example.com';
const START = new Date('2026-01-01T00:00:00Z');

function setup() {
  const fake = createFakeLoginAttempts();
  const service = new LoginThrottleService(fake.model as never);
  return { service, ...fake };
}

/** 시도를 하나씩 쓰며 결과를 모은다 */
async function reserveTimes(service: LoginThrottleService, n: number, email = EMAIL) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await service.reserve(email));
  return results;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('상수', () => {
  it('한도는 5번, 잠금은 15분이다 (값을 못박는다)', () => {
    expect(LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(LOGIN_LOCK_MS).toBe(15 * 60 * 1000);
  });
});

describe('LoginThrottleService.reserve', () => {
  describe('한도 안', () => {
    it('처음 시도는 쓸 수 있고 기록이 생긴다', async () => {
      const { service, rows } = setup();

      expect(await service.reserve(EMAIL)).toEqual({ ok: true });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email: EMAIL, attempts: 1, lastAttemptAt: START });
    });

    it('5번까지 쓸 수 있다', async () => {
      const { service, rows } = setup();

      const results = await reserveTimes(service, LOGIN_MAX_ATTEMPTS);

      expect(results.every((r) => r.ok)).toBe(true);
      expect(rows[0]!.attempts).toBe(5);
    });

    it('만료 시각은 마지막 시도로부터 15분 뒤다', async () => {
      const { service, rows } = setup();

      await service.reserve(EMAIL);

      expect(rows[0]!.expiresAt).toEqual(new Date(START.getTime() + LOGIN_LOCK_MS));
    });

    it('시도할 때마다 마지막 시도 시각과 만료 시각이 갱신된다', async () => {
      const { service, rows } = setup();
      await service.reserve(EMAIL);
      const later = new Date(START.getTime() + 60_000);
      vi.setSystemTime(later);

      await service.reserve(EMAIL);

      expect(rows[0]).toMatchObject({
        attempts: 2,
        lastAttemptAt: later,
        expiresAt: new Date(later.getTime() + LOGIN_LOCK_MS),
      });
    });

    it('이메일이 다르면 서로 영향을 주지 않는다', async () => {
      const { service, rows } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS, 'a@example.com');

      expect(await service.reserve('b@example.com')).toEqual({ ok: true });
      expect(rows).toHaveLength(2);
    });
  });

  describe('잠금', () => {
    it('6번째 시도는 막히고 남은 시간을 알려 준다', async () => {
      const { service } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS);

      expect(await service.reserve(EMAIL)).toEqual({ ok: false, retryAfterMs: LOGIN_LOCK_MS });
    });

    it('남은 시간은 마지막 시도로부터 계산한다', async () => {
      const { service } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS);
      vi.setSystemTime(new Date(START.getTime() + 5 * 60 * 1000));

      expect(await service.reserve(EMAIL)).toEqual({
        ok: false,
        retryAfterMs: 10 * 60 * 1000,
      });
    });

    it('잠금 중의 요청은 기록을 건드리지 않는다 (잠금이 끝없이 늘어나지 않는다)', async () => {
      const { service, rows } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS);
      const before = { ...rows[0]! };
      vi.setSystemTime(new Date(START.getTime() + 60_000));

      await service.reserve(EMAIL);
      await service.reserve(EMAIL);

      expect(rows[0]).toEqual(before);
    });

    it('계속 시도해도 잠금 시간이 늘지 않아, 처음 잠긴 시각 기준으로 풀린다', async () => {
      const { service } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS);
      for (let i = 1; i <= 10; i++) {
        vi.setSystemTime(new Date(START.getTime() + i * 60_000));
        await service.reserve(EMAIL);
      }

      vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS));
      expect(await service.reserve(EMAIL)).toEqual({ ok: true });
    });

    it('잠금이 정확히 끝나는 순간(15분)부터 다시 시도할 수 있다 (경계)', async () => {
      const { service } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS);

      vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS - 1));
      expect((await service.reserve(EMAIL)).ok).toBe(false);

      vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS));
      expect((await service.reserve(EMAIL)).ok).toBe(true);
    });

    it('잠금이 풀리면 횟수를 처음부터 센다 (다시 5번 쓸 수 있다)', async () => {
      const { service, rows } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS);
      vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS));

      const results = await reserveTimes(service, LOGIN_MAX_ATTEMPTS);

      expect(results.every((r) => r.ok)).toBe(true);
      expect(rows[0]!.attempts).toBe(5);
      expect((await service.reserve(EMAIL)).ok).toBe(false);
    });

    it('한도에 닿지 않은 채 오래 지나도(15분) 횟수를 처음부터 센다', async () => {
      const { service, rows } = setup();
      await reserveTimes(service, 3);
      vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS));

      await service.reserve(EMAIL);

      expect(rows[0]!.attempts).toBe(1);
    });

    it('한도에 닿기 전에 천천히 시도하면 횟수가 쌓인다 (14분 간격이면 처음으로 돌아가지 않는다)', async () => {
      const { service } = setup();
      const results = [];
      for (let i = 0; i < 6; i++) {
        vi.setSystemTime(new Date(START.getTime() + i * 14 * 60 * 1000));
        results.push(await service.reserve(EMAIL));
      }

      expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, false]);
    });
  });

  describe('동시 요청', () => {
    it('같은 이메일로 동시에 100번 시도해도 5번만 통과한다 (비밀번호 확인이 5번까지만 일어난다)', async () => {
      const { service, rows } = setup();

      const results = await Promise.all(Array.from({ length: 100 }, () => service.reserve(EMAIL)));

      expect(results.filter((r) => r.ok)).toHaveLength(LOGIN_MAX_ATTEMPTS);
      expect(results.filter((r) => !r.ok)).toHaveLength(100 - LOGIN_MAX_ATTEMPTS);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.attempts).toBe(LOGIN_MAX_ATTEMPTS);
    });

    it('이미 기록이 있을 때 동시에 몰려도 남은 횟수만큼만 통과한다', async () => {
      const { service, rows } = setup();
      await reserveTimes(service, 3);

      const results = await Promise.all(Array.from({ length: 50 }, () => service.reserve(EMAIL)));

      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(rows[0]!.attempts).toBe(5);
    });

    it('잠금이 막 풀린 순간 동시에 몰려도 5번만 통과한다', async () => {
      const { service, rows } = setup();
      await reserveTimes(service, LOGIN_MAX_ATTEMPTS);
      vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS));

      const results = await Promise.all(Array.from({ length: 100 }, () => service.reserve(EMAIL)));

      expect(results.filter((r) => r.ok)).toHaveLength(LOGIN_MAX_ATTEMPTS);
      expect(rows[0]!.attempts).toBe(LOGIN_MAX_ATTEMPTS);
    });

    it('서로 다른 이메일 여러 개가 동시에 와도 각자 5번씩이다', async () => {
      const { service, rows } = setup();
      const emails = ['a@x.com', 'b@x.com', 'c@x.com'];

      const results = await Promise.all(
        emails.flatMap((e) => Array.from({ length: 20 }, () => service.reserve(e))),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(15);
      expect(rows.map((r) => r.attempts)).toEqual([5, 5, 5]);
    });
  });
});

describe('LoginThrottleService.clear', () => {
  it('기록을 지워 횟수를 처음부터 센다', async () => {
    const { service, rows } = setup();
    await reserveTimes(service, 4);

    await service.clear(EMAIL);

    expect(rows).toHaveLength(0);
    expect((await reserveTimes(service, LOGIN_MAX_ATTEMPTS)).every((r) => r.ok)).toBe(true);
  });

  it('잠긴 뒤에는 지우면 바로 다시 시도할 수 있다', async () => {
    const { service } = setup();
    await reserveTimes(service, LOGIN_MAX_ATTEMPTS);

    await service.clear(EMAIL);

    expect((await service.reserve(EMAIL)).ok).toBe(true);
  });

  it('기록이 없어도 오류 없이 끝난다', async () => {
    const { service } = setup();

    await expect(service.clear(EMAIL)).resolves.toBeUndefined();
  });

  it('목록의 첫 번째가 아닌 이메일을 지워도 그 이메일만 지워진다 (필터 없이 아무거나 지우지 않는다)', async () => {
    const { service, rows } = setup();
    await service.reserve('a@example.com');
    await service.reserve('b@example.com');
    await service.reserve('c@example.com');

    await service.clear('b@example.com');

    expect(rows.map((r) => r.email)).toEqual(['a@example.com', 'c@example.com']);
  });

  it('다른 이메일의 기록은 지우지 않는다', async () => {
    const { service, rows } = setup();
    await service.reserve('a@example.com');
    await service.reserve('b@example.com');

    await service.clear('a@example.com');

    expect(rows.map((r) => r.email)).toEqual(['b@example.com']);
  });
});

describe('기록이 중간에 사라진 경우 (만료 삭제와 겹침)', () => {
  it('한도 확인 뒤 남은 시간을 읽을 때 기록이 이미 지워졌다면 기다릴 필요가 없다고(0) 알린다', async () => {
    const f = createFakeLoginAttempts();
    const service = new LoginThrottleService(f.model as never);
    // 첫 조회(존재 확인)는 기록이 있는 것으로, 이후 조회(남은 시간)는 지워진 것으로 보이게 한다
    f.rows.push({
      _id: undefined as never,
      email: EMAIL,
      attempts: LOGIN_MAX_ATTEMPTS,
      lastAttemptAt: new Date(START.getTime() + 1),
      expiresAt: new Date(START.getTime() + LOGIN_LOCK_MS),
    });
    const realFindOne = f.model.findOne;
    let n = 0;
    f.model.findOne = ((filter: never) => {
      n++;
      return n === 1 ? realFindOne(filter) : { lean: () => Promise.resolve(null) };
    }) as never;

    const result = await service.reserve(EMAIL);

    expect(result).toEqual({ ok: false, retryAfterMs: 0 });
  });
});

describe('저장소 오류', () => {
  it('새 기록을 만들다 중복 키가 아닌 오류가 나면 그대로 던진다 (장애를 잠금으로 숨기지 않는다)', async () => {
    const f = createFakeLoginAttempts();
    f.model.create = () => Promise.reject(new Error('DB 연결 끊김'));
    const service = new LoginThrottleService(f.model as never);

    await expect(service.reserve(EMAIL)).rejects.toThrow('DB 연결 끊김');
  });

  it('조회 중 오류도 그대로 던진다', async () => {
    const f = createFakeLoginAttempts();
    f.model.findOne = () => ({ lean: () => Promise.reject(new Error('DB 읽기 실패')) }) as never;
    const service = new LoginThrottleService(f.model as never);

    await expect(service.reserve(EMAIL)).rejects.toThrow('DB 읽기 실패');
  });

  it('중복 키 경합에서 지고 한도도 찬 경우에는 잠긴 것으로 응답한다', async () => {
    const f = createFakeLoginAttempts();
    const service = new LoginThrottleService(f.model as never);
    // 다른 요청이 이미 한도까지 채워 둔 상태에서 create가 중복 키로 실패하는 상황
    f.rows.push({
      _id: undefined as never,
      email: EMAIL,
      attempts: LOGIN_MAX_ATTEMPTS,
      lastAttemptAt: START,
      expiresAt: new Date(START.getTime() + LOGIN_LOCK_MS),
    });
    const realFindOne = f.model.findOne;
    let first = true;
    f.model.findOne = ((filter: never) => {
      // 첫 조회는 "기록 없음"으로 보이게 해 create 경로로 들어가게 한다
      if (first) {
        first = false;
        return { lean: () => Promise.resolve(null) };
      }
      return realFindOne(filter);
    }) as never;

    const result = await service.reserve(EMAIL);

    expect(result).toEqual({ ok: false, retryAfterMs: LOGIN_LOCK_MS });
  });
});
