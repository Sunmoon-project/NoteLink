import { hash } from 'bcrypt';
import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_LOGIN_ERRORS } from '../src/modules/auth/app-login/app-login-errors.js';
import { AppLoginService } from '../src/modules/auth/app-login/app-login.service.js';
import {
  LOGIN_LOCK_MS,
  LOGIN_MAX_ATTEMPTS,
  LoginThrottleService,
} from '../src/modules/auth/app-login/login-throttle.service.js';
import { createFakeLoginAttempts } from './support/fake-login-attempts.js';

const EMAIL = 'student@example.com';
const PASSWORD = 'Passw0rdOK';
const WRONG = 'WrongPassw0rd';
const TEST_COST = 4;
const START = new Date('2026-01-01T00:00:00Z');

interface UserRow {
  _id: Types.ObjectId;
  email: string | null;
  passwordHash: string | null;
  nickname: string;
  deletedAt: Date | null;
  lastLoginAt: Date | null;
}

let goodHash: string;
beforeAll(async () => {
  goodHash = await hash(PASSWORD, TEST_COST);
});

function setup(rows: UserRow[] = []) {
  const attempts = createFakeLoginAttempts();
  const throttle = new LoginThrottleService(attempts.model as never);
  const issued: string[] = [];
  const tokens = {
    issue: (id: string) => {
      issued.push(id);
      return Promise.resolve({ accessToken: 'a', refreshToken: 'r' });
    },
  };
  const model = {
    findOne: (f: { email: string; deletedAt: null }) => ({
      lean: () =>
        Promise.resolve(
          rows.find((r) => r.email === f.email && r.deletedAt === f.deletedAt) ?? null,
        ),
    }),
    updateOne: () => Promise.resolve({}),
  };
  const service = new AppLoginService(model as never, tokens as never, throttle, TEST_COST);
  return { service, issued, attempts: attempts.rows };
}

const user = (overrides: Partial<UserRow> = {}): UserRow => ({
  _id: new Types.ObjectId(),
  email: EMAIL,
  passwordHash: goodHash,
  nickname: '노트링크',
  deletedAt: null,
  lastLoginAt: null,
  ...overrides,
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { getStatus: () => number; getResponse: () => Record<string, unknown> };
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

/** 틀린 비밀번호로 n번 시도한다 */
async function failTimes(service: AppLoginService, n: number, email = EMAIL, password = WRONG) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await failure(service.login(email, password)));
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('로그인 시도 제한 (5번 실패하면 잠긴다)', () => {
  it('틀린 비밀번호로 5번까지는 401 INVALID_CREDENTIALS이다', async () => {
    const { service } = setup([user()]);

    const results = await failTimes(service, LOGIN_MAX_ATTEMPTS);

    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body['code']).toBe(APP_LOGIN_ERRORS.INVALID_CREDENTIALS);
    }
  });

  it('6번째는 429 LOGIN_LOCKED이고 남은 시간(초)을 알려 준다', async () => {
    const { service } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);

    const result = await failure(service.login(EMAIL, WRONG));

    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({
      code: APP_LOGIN_ERRORS.LOGIN_LOCKED,
      retryAfterSeconds: LOGIN_LOCK_MS / 1000,
    });
  });

  it('잠긴 동안에는 맞는 비밀번호도 받지 않는다 (잠금 뒤에 맞춘 비밀번호로 뚫지 못한다)', async () => {
    const { service, issued } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);

    const result = await failure(service.login(EMAIL, PASSWORD));

    expect(result.status).toBe(429);
    expect(issued).toHaveLength(0);
  });

  it('5번째 시도가 맞는 비밀번호면 로그인된다 (4번 틀리고 맞춘 정상 사용자)', async () => {
    const { service, issued } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS - 1);

    await expect(service.login(EMAIL, PASSWORD)).resolves.toBeDefined();
    expect(issued).toHaveLength(1);
  });

  it('성공하면 횟수가 지워져서 다시 5번을 쓸 수 있다', async () => {
    const { service, attempts } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS - 1);
    await service.login(EMAIL, PASSWORD);

    expect(attempts).toHaveLength(0);
    const results = await failTimes(service, LOGIN_MAX_ATTEMPTS);
    expect(results.every((r) => r.status === 401)).toBe(true);
  });

  it('잠금이 풀리면(15분) 다시 로그인할 수 있다', async () => {
    const { service } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);
    vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS));

    await expect(service.login(EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it('잠긴 동안 계속 시도해도 잠금이 늘어나지 않는다', async () => {
    const { service } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);
    for (let i = 1; i <= 10; i++) {
      vi.setSystemTime(new Date(START.getTime() + i * 60_000));
      await failure(service.login(EMAIL, WRONG));
    }

    vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS));
    await expect(service.login(EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it('실패 시도가 잠금 응답을 포함해도 응답에 비밀번호를 넣지 않는다', async () => {
    const { service } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);

    const result = await failure(service.login(EMAIL, WRONG));

    expect(JSON.stringify(result.body)).not.toContain(WRONG);
    expect(JSON.stringify(result.body)).not.toContain(PASSWORD);
  });
});

describe('재시도 시간은 올림으로 알린다 (내림하면 클라이언트가 1초 일찍 다시 눌러 또 거부당한다)', () => {
  it('남은 시간이 1.5초면 2초로 알린다', async () => {
    const { service } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);
    vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS - 1_500));

    const result = await failure(service.login(EMAIL, WRONG));

    expect(result.body['retryAfterSeconds']).toBe(2);
  });

  it('남은 시간이 1밀리초여도 1초로 알린다 (0초로 알리면 즉시 재시도해 또 거부당한다)', async () => {
    const { service } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);
    vi.setSystemTime(new Date(START.getTime() + LOGIN_LOCK_MS - 1));

    const result = await failure(service.login(EMAIL, WRONG));

    expect(result.body['retryAfterSeconds']).toBe(1);
  });
});

describe('잠금은 계정이 있는지와 상관없이 똑같다 (잠금 여부로 가입 여부가 드러나지 않는다)', () => {
  const SCENARIOS: [string, () => UserRow[]][] = [
    ['계정이 있음', () => [user()]],
    ['계정이 없음', () => []],
    ['소셜 전용 계정', () => [user({ passwordHash: null })]],
    ['탈퇴한 계정', () => [user({ deletedAt: new Date() })]],
  ];

  it.each(SCENARIOS)('%s: 5번째까지 401, 6번째부터 429', async (_name, rows) => {
    const { service } = setup(rows());

    const first = await failTimes(service, LOGIN_MAX_ATTEMPTS);
    const sixth = await failure(service.login(EMAIL, WRONG));

    expect(first.every((r) => r.status === 401)).toBe(true);
    expect(sixth.status).toBe(429);
    expect(sixth.body['code']).toBe(APP_LOGIN_ERRORS.LOGIN_LOCKED);
  });

  it('모든 경우의 잠금 응답이 완전히 같다', async () => {
    const results = [];
    for (const [, rows] of SCENARIOS) {
      const { service } = setup(rows());
      await failTimes(service, LOGIN_MAX_ATTEMPTS);
      results.push(await failure(service.login(EMAIL, WRONG)));
    }

    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('모든 경우의 5번째 실패 응답이 완전히 같다 (마지막 시도에서 가입 여부가 갈리지 않는다)', async () => {
    const results = [];
    for (const [, rows] of SCENARIOS) {
      const { service } = setup(rows());
      const all = await failTimes(service, LOGIN_MAX_ATTEMPTS);
      results.push(all[LOGIN_MAX_ATTEMPTS - 1]);
    }

    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('없는 이메일에도 시도 기록이 남는다 (존재하는 계정에만 기록하면 기록 유무로 드러난다)', async () => {
    const { service, attempts } = setup([]);

    await failure(service.login('nobody@example.com', WRONG));

    expect(attempts.map((a) => a.email)).toEqual(['nobody@example.com']);
  });
});

describe('이메일마다 따로 센다', () => {
  it('한 이메일이 잠겨도 다른 이메일은 로그인할 수 있다', async () => {
    const other = user({ email: 'other@example.com' });
    const { service } = setup([user(), other]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS);

    await expect(service.login('other@example.com', PASSWORD)).resolves.toBeDefined();
  });

  it('한 이메일에 틀려도 다른 이메일의 횟수는 늘지 않는다', async () => {
    const { service, attempts } = setup([user(), user({ email: 'other@example.com' })]);

    await failTimes(service, 3);

    expect(attempts.map((a) => [a.email, a.attempts])).toEqual([[EMAIL, 3]]);
  });
});

describe('비밀번호 확인 전에 시도를 먼저 쓴다', () => {
  it('틀린 비밀번호 4개를 먼저 쓴 뒤 맞는 비밀번호와 틀린 비밀번호를 동시에 보내면, 남은 1번만 처리된다', async () => {
    const { service, issued } = setup([user()]);
    await failTimes(service, LOGIN_MAX_ATTEMPTS - 1);

    const results = await Promise.allSettled([
      service.login(EMAIL, PASSWORD),
      ...Array.from({ length: 10 }, () => service.login(EMAIL, WRONG)),
    ]);

    // 남은 시도는 1번뿐이라, 동시에 시작한 11개 중 비밀번호 확인까지 가는 건 1개다(나머지 10개는 확인 없이 429)
    const checked = results.filter(
      (r) => r.status === 'fulfilled' || (r.reason as { status: number }).status === 401,
    );
    const locked = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { status: number }).status === 429,
    );
    expect(checked).toHaveLength(1);
    expect(locked).toHaveLength(10);
    expect(issued.length).toBeLessThanOrEqual(1);
  });

  it('동시에 틀린 비밀번호 100개를 보내도 비밀번호 확인은 5번까지만 일어난다', async () => {
    const { service, attempts } = setup([user()]);

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => service.login(EMAIL, WRONG)),
    );

    const unauthorized = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { status: number }).status === 401,
    ).length;
    const locked = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { status: number }).status === 429,
    ).length;
    expect(unauthorized).toBe(LOGIN_MAX_ATTEMPTS);
    expect(locked).toBe(100 - LOGIN_MAX_ATTEMPTS);
    expect(attempts[0]!.attempts).toBe(LOGIN_MAX_ATTEMPTS);
  });
});

describe('저장소 오류', () => {
  it('시도 제한 저장소가 실패하면 그대로 던진다 (제한 장애 때 제한 없이 통과시키지 않는다)', async () => {
    const broken = {
      reserve: () => Promise.reject(new Error('DB 연결 끊김')),
      clear: () => Promise.resolve(),
    };
    const service = new AppLoginService(
      { findOne: () => ({ lean: () => Promise.resolve(user()) }) } as never,
      {} as never,
      broken as never,
      TEST_COST,
    );

    await expect(service.login(EMAIL, PASSWORD)).rejects.toThrow('DB 연결 끊김');
  });

  it('제한 저장소가 실패하면 비밀번호를 확인하지도 않는다', async () => {
    const findOne = vi.fn();
    const service = new AppLoginService(
      { findOne } as never,
      {} as never,
      { reserve: () => Promise.reject(new Error('x')), clear: () => Promise.resolve() } as never,
      TEST_COST,
    );

    await service.login(EMAIL, PASSWORD).catch(() => {});

    expect(findOne).not.toHaveBeenCalled();
  });
});
