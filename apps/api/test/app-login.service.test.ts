import { hash } from 'bcrypt';
import { Types } from 'mongoose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 실제 bcrypt를 쓰되 compare 호출(어떤 해시와 비교했는지)을 기록한다
vi.mock('bcrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcrypt')>();
  return { ...actual, compare: vi.fn(actual.compare) };
});

import { compare } from 'bcrypt';

import { APP_LOGIN_ERRORS } from '../src/modules/auth/app-login/app-login-errors.js';
import { AppLoginService } from '../src/modules/auth/app-login/app-login.service.js';

const EMAIL = 'student@example.com';
const PASSWORD = 'Passw0rdOK';
const TEST_COST = 4;

interface UserRow {
  _id: Types.ObjectId;
  email: string | null;
  passwordHash: string | null;
  nickname: string;
  role: string;
  learnerType: string | null;
  pointBalance: number;
  settings: Record<string, unknown>;
  status: string;
  interestCategoryIds: Types.ObjectId[];
  socialAccounts: { provider: string; providerUid: string }[];
  lastLoginAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}

let goodHash: string;
beforeAll(async () => {
  goodHash = await hash(PASSWORD, TEST_COST);
});

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    _id: new Types.ObjectId(),
    email: EMAIL,
    passwordHash: goodHash,
    nickname: '노트링크',
    role: 'user',
    learnerType: null,
    pointBalance: 0,
    settings: {},
    status: 'active',
    interestCategoryIds: [],
    socialAccounts: [],
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

function setup(rows: UserRow[] = []) {
  const issued: string[] = [];
  const tokens = {
    issue: (userId: string) => {
      issued.push(userId);
      return Promise.resolve({
        accessToken: `access-${userId}`,
        refreshToken: `refresh-${userId}`,
      });
    },
  };
  const model = {
    // 실제 Mongo처럼 필터에 적힌 항목만 따진다
    findOne: (f: { email: string; deletedAt: null }) => ({
      lean: () =>
        Promise.resolve(
          rows.find((r) => r.email === f.email && r.deletedAt === f.deletedAt) ?? null,
        ),
    }),
    updateOne: (f: { _id: Types.ObjectId }, update: { $set: { lastLoginAt: Date } }) => {
      const row = rows.find((r) => r._id.equals(f._id));
      if (row) Object.assign(row, update.$set);
      return Promise.resolve({ matchedCount: row ? 1 : 0 });
    },
  };
  const service = new AppLoginService(model as never, tokens as never, TEST_COST);
  return { service, rows, issued };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { getStatus: () => number; getResponse: () => Record<string, unknown> };
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

beforeEach(() => {
  vi.mocked(compare).mockClear();
});

describe('AppLoginService.login 성공', () => {
  it('토큰 한 쌍과 사용자 정보를 돌려준다', async () => {
    const row = userRow();
    const { service } = setup([row]);

    const result = await service.login(EMAIL, PASSWORD);

    expect(result.accessToken).toBe(`access-${row._id}`);
    expect(result.refreshToken).toBe(`refresh-${row._id}`);
    expect(result.user).toMatchObject({ _id: String(row._id), email: EMAIL, nickname: '노트링크' });
  });

  it('그 사용자의 id로 토큰을 발급한다', async () => {
    const row = userRow();
    const { service, issued } = setup([row]);

    await service.login(EMAIL, PASSWORD);

    expect(issued).toEqual([String(row._id)]);
  });

  it('마지막 로그인 시각을 갱신한다', async () => {
    const row = userRow();
    const { service } = setup([row]);
    const before = Date.now();

    await service.login(EMAIL, PASSWORD);

    expect(row.lastLoginAt).toBeInstanceOf(Date);
    expect(row.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('응답에 비밀번호 해시 · 소셜 연동 정보가 없다', async () => {
    const { service } = setup([
      userRow({ socialAccounts: [{ provider: 'google', providerUid: 'uid-secret' }] }),
    ]);

    const result = await service.login(EMAIL, PASSWORD);

    const text = JSON.stringify(result);
    expect(text).not.toContain(goodHash);
    expect(text).not.toMatch(/passwordHash|socialAccounts|providerUid|uid-secret/);
  });

  it('여러 사용자 중 이메일이 맞는 사용자로 로그인한다', async () => {
    const other = userRow({ email: 'other@example.com' });
    const mine = userRow();
    const { service } = setup([other, mine]);

    const result = await service.login(EMAIL, PASSWORD);

    expect(result.user._id).toBe(String(mine._id));
  });

  it('성공해도 bcrypt 비교는 한 번만 한다', async () => {
    const { service } = setup([userRow()]);

    await service.login(EMAIL, PASSWORD);

    expect(compare).toHaveBeenCalledTimes(1);
  });
});

describe('AppLoginService.login 실패: 이유를 알리지 않는다', () => {
  const CASES: [string, () => { rows: UserRow[]; email?: string; password?: string }][] = [
    ['틀린 비밀번호', () => ({ rows: [userRow()], password: 'WrongPassw0rd' })],
    ['존재하지 않는 이메일', () => ({ rows: [userRow()], email: 'nobody@example.com' })],
    ['계정이 하나도 없음', () => ({ rows: [] })],
    ['소셜로만 가입한 계정(비밀번호 없음)', () => ({ rows: [userRow({ passwordHash: null })] })],
    ['탈퇴한 계정', () => ({ rows: [userRow({ deletedAt: new Date() })] })],
    ['비밀번호가 빈 해시 문자열', () => ({ rows: [userRow({ passwordHash: '' })] })],
  ];

  it.each(CASES)('%s이면 401 INVALID_CREDENTIALS이다', async (_name, make) => {
    const { rows, email = EMAIL, password = PASSWORD } = make();
    const { service } = setup(rows);

    const result = await failure(service.login(email, password));

    expect(result.status).toBe(401);
    expect(result.body['code']).toBe(APP_LOGIN_ERRORS.INVALID_CREDENTIALS);
  });

  it('모든 실패 경우의 응답(상태 · 코드 · 문구)이 완전히 같다 (응답으로 가입 여부를 구분할 수 없다)', async () => {
    const results = [];
    for (const [, make] of CASES) {
      const { rows, email = EMAIL, password = PASSWORD } = make();
      results.push(await failure(setup(rows).service.login(email, password)));
    }

    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('응답 문구는 어느 쪽이 틀렸는지 알려 주지 않는다', async () => {
    const { service } = setup([userRow()]);

    const result = await failure(service.login(EMAIL, 'WrongPassw0rd'));

    expect(result.body['message']).toBe('이메일 또는 비밀번호가 맞지 않아요');
  });

  it('토큰 만료 코드(AUTH_TOKEN_EXPIRED)를 쓰지 않는다 (앱이 토큰 갱신을 시도하지 않는다)', async () => {
    const { service } = setup([userRow()]);

    const result = await failure(service.login(EMAIL, 'WrongPassw0rd'));

    expect(result.body['code']).not.toBe('AUTH_TOKEN_EXPIRED');
  });

  it('실패하면 토큰을 발급하지 않고 로그인 시각도 갱신하지 않는다', async () => {
    const row = userRow();
    const { service, issued } = setup([row]);

    await failure(service.login(EMAIL, 'WrongPassw0rd'));

    expect(issued).toHaveLength(0);
    expect(row.lastLoginAt).toBeNull();
  });

  it('오류 응답에 입력한 비밀번호 · 해시가 들어 있지 않다', async () => {
    const { service } = setup([userRow()]);

    const result = await failure(service.login(EMAIL, 'WrongPassw0rd'));

    const text = JSON.stringify(result.body);
    expect(text).not.toContain('WrongPassw0rd');
    expect(text).not.toContain(goodHash);
  });
});

describe('응답 시간 평준화: 어떤 경우에도 bcrypt 비교를 한 번 한다', () => {
  const TIMING_CASES: [string, () => { rows: UserRow[]; email?: string; password?: string }][] = [
    ['틀린 비밀번호', () => ({ rows: [userRow()], password: 'WrongPassw0rd' })],
    ['존재하지 않는 이메일', () => ({ rows: [userRow()], email: 'nobody@example.com' })],
    ['소셜 전용 계정', () => ({ rows: [userRow({ passwordHash: null })] })],
    ['탈퇴한 계정', () => ({ rows: [userRow({ deletedAt: new Date() })] })],
  ];

  it.each(TIMING_CASES)(
    '%s에서도 비교를 정확히 한 번 한다 (건너뛰면 응답이 빨라져 가입 여부가 드러난다)',
    async (_n, make) => {
      const { rows, email = EMAIL, password = PASSWORD } = make();
      const { service } = setup(rows);

      await failure(service.login(email, password));

      expect(compare).toHaveBeenCalledTimes(1);
    },
  );

  it('계정이 없을 때는 실제 계정과 같은 비용의 가짜 해시와 비교한다', async () => {
    const { service } = setup([]);

    await failure(service.login(EMAIL, PASSWORD));

    const target = vi.mocked(compare).mock.calls[0]![1] as string;
    expect(target).toMatch(/^\$2[aby]\$04\$/); // 주입한 비용(4)과 같다
  });

  it('비용을 바꾸면 가짜 해시의 비용도 따라간다', async () => {
    const service = new AppLoginService(
      { findOne: () => ({ lean: () => Promise.resolve(null) }) } as never,
      {} as never,
      5,
    );

    await failure(service.login(EMAIL, PASSWORD));

    expect(vi.mocked(compare).mock.calls[0]![1]).toMatch(/^\$2[aby]\$05\$/);
  });

  it('가짜 해시는 한 번 만들어 재사용한다 (요청마다 새로 만들지 않는다)', async () => {
    const { service } = setup([]);

    await failure(service.login(EMAIL, PASSWORD));
    await failure(service.login(EMAIL, PASSWORD));
    await failure(service.login('other@example.com', PASSWORD));

    const targets = vi.mocked(compare).mock.calls.map((c) => c[1]);
    expect(new Set(targets).size).toBe(1);
  });

  it('가짜 해시는 어떤 입력과도 맞지 않는다 (소셜 전용 계정에 비밀번호를 넣어도 로그인되지 않는다)', async () => {
    const { service } = setup([userRow({ passwordHash: null })]);

    for (const guess of [PASSWORD, '', 'dummy', 'Passw0rd', '12345678a']) {
      await expect(service.login(EMAIL, guess)).rejects.toMatchObject({ status: 401 });
    }
  });

  it('동시에 처음 요청이 여러 개 와도 가짜 해시는 하나만 만든다', async () => {
    const { service } = setup([]);

    await Promise.allSettled(Array.from({ length: 5 }, () => service.login(EMAIL, PASSWORD)));

    const targets = vi.mocked(compare).mock.calls.map((c) => c[1]);
    expect(new Set(targets).size).toBe(1);
  });
});

describe('소셜 전용 계정은 두 겹으로 막는다 (한쪽이 없어져도 다른 쪽이 막지만, 각각 따로 지켜야 한다)', () => {
  /** 비교가 항상 "맞음"을 돌려준다고 가정한다: 해시 검증에만 기대면 뚫리는 상황을 만든다 */
  function withCompareAlwaysTrue() {
    vi.mocked(compare).mockImplementationOnce((() => Promise.resolve(true)) as never);
  }

  it('비밀번호가 없는 계정은 비교가 "맞음"이어도 거부한다 (해시 검증과 별개로 소셜 전용을 직접 막는다)', async () => {
    const { service } = setup([userRow({ passwordHash: null })]);
    withCompareAlwaysTrue();

    const result = await failure(service.login(EMAIL, 'anything'));

    expect(result.status).toBe(401);
  });

  it('존재하지 않는 이메일도 비교가 "맞음"이어도 거부한다 (사용자가 없으면 무조건 거부)', async () => {
    const { service, issued } = setup([]);
    withCompareAlwaysTrue();

    const result = await failure(service.login(EMAIL, 'anything'));

    expect(result.status).toBe(401);
    expect(issued).toHaveLength(0);
  });

  it('가짜 해시의 원문은 서비스마다 무작위다 (고정값이면 그 값으로 뚫린다)', async () => {
    const a = setup([]);
    const b = setup([]);

    await failure(a.service.login(EMAIL, PASSWORD));
    await failure(b.service.login(EMAIL, PASSWORD));

    const [hashA, hashB] = vi.mocked(compare).mock.calls.map((c) => c[1] as string);
    expect(hashA).not.toBe(hashB);
  });

  it('가짜 해시의 원문은 고정값이 아니다 (알려진 값으로 비교하면 가짜 해시와 맞지 않는다)', async () => {
    const { service } = setup([]);
    await failure(service.login(EMAIL, PASSWORD));
    const dummy = vi.mocked(compare).mock.calls[0]![1] as string;
    const actual = await vi.importActual<typeof import('bcrypt')>('bcrypt');

    for (const guess of ['fixed-dummy-password', 'dummy', 'password', PASSWORD, '']) {
      expect(await actual.compare(guess, dummy)).toBe(false);
    }
  });

  it('가짜 해시와 비교할 때 사용자 해시가 아닌 다른 해시를 쓴다', async () => {
    const { service } = setup([userRow({ passwordHash: null })]);

    await failure(service.login(EMAIL, PASSWORD));

    const target = vi.mocked(compare).mock.calls[0]![1] as string;
    expect(target).not.toBe(goodHash);
    expect(target).toMatch(/^\$2[aby]\$/);
  });
});

describe('72바이트를 넘는 입력', () => {
  // bcrypt는 앞 72바이트만 반영한다. 가입 때 72바이트를 넘는 비밀번호는 받지 않으므로 넘는 입력은 맞을 수 없다
  it('앞 72바이트가 비밀번호와 같아도 그 뒤에 더 붙인 입력은 로그인되지 않는다', async () => {
    const base = `${'a'.repeat(71)}1`; // 72바이트
    const row = userRow({ passwordHash: await hash(base, TEST_COST) });
    const { service } = setup([row]);

    await expect(service.login(EMAIL, base)).resolves.toBeDefined();
    const result = await failure(service.login(EMAIL, `${base}EXTRA`));

    expect(result.status).toBe(401);
  });

  it('72바이트를 넘는 입력도 bcrypt 비교는 한 번 한다 (시간 차이를 만들지 않는다)', async () => {
    const { service } = setup([userRow()]);

    await failure(service.login(EMAIL, 'a'.repeat(100)));

    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('정확히 72바이트는 허용한다 (경계)', async () => {
    const exact = `${'a'.repeat(71)}1`;
    const { service } = setup([userRow({ passwordHash: await hash(exact, TEST_COST) })]);

    await expect(service.login(EMAIL, exact)).resolves.toBeDefined();
  });

  it('한글 등 여러 바이트 글자로 72바이트를 넘으면 거부한다 (글자 수가 아니라 바이트 기준)', async () => {
    // 앞 72바이트(a1 + 한글 23자 + a)로 해시를 만든 계정. 뒤에 한 글자를 더 붙인 입력은 글자 수로는 짧지만 바이트로는 넘는다
    const stored = `a1${'가'.repeat(23)}a`; // 글자 26자, 72바이트
    const tooLongByBytes = `${stored}가`; // 글자 27자(64자 이하), 75바이트
    expect(Buffer.byteLength(stored)).toBe(72);
    expect(tooLongByBytes.length).toBeLessThanOrEqual(64);
    const { service } = setup([userRow({ passwordHash: await hash(stored, TEST_COST) })]);

    await expect(service.login(EMAIL, stored)).resolves.toBeDefined();
    const result = await failure(service.login(EMAIL, tooLongByBytes));

    expect(result.status).toBe(401);
  });

  it('73바이트는 거부한다 (상한 경계: 72는 허용, 73은 거부)', async () => {
    const stored = `${'a'.repeat(71)}1`; // 72바이트
    const { service } = setup([userRow({ passwordHash: await hash(stored, TEST_COST) })]);

    // bcrypt는 앞 72바이트만 보므로, 73바이트 입력은 해시 비교로는 맞아 버린다. 직접 막아야 한다
    const result = await failure(service.login(EMAIL, `${stored}x`));

    expect(result.status).toBe(401);
  });
});

describe('저장소 오류', () => {
  it('사용자 조회가 실패하면 그대로 던진다 (장애를 "비밀번호 틀림"으로 숨기지 않는다)', async () => {
    const service = new AppLoginService(
      { findOne: () => ({ lean: () => Promise.reject(new Error('DB 읽기 실패')) }) } as never,
      {} as never,
      TEST_COST,
    );

    await expect(service.login(EMAIL, PASSWORD)).rejects.toThrow('DB 읽기 실패');
  });

  it('토큰 발급이 실패하면 그대로 던진다', async () => {
    const row = userRow();
    const service = new AppLoginService(
      {
        findOne: () => ({ lean: () => Promise.resolve(row) }),
        updateOne: () => Promise.resolve({}),
      } as never,
      { issue: () => Promise.reject(new Error('토큰 발급 실패')) } as never,
      TEST_COST,
    );

    await expect(service.login(EMAIL, PASSWORD)).rejects.toThrow('토큰 발급 실패');
  });
});
