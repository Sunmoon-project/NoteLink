import { type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ERROR_CODES, PATHS } from '@notelink/shared';
import { compare, hash } from 'bcrypt';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  nextSeoulMidnight,
} from '../src/modules/auth/app-login/email-code.service.js';
import { MAIL_SENDER, type MailSender } from '../src/modules/mail/mail-sender.js';
import { AuthCode } from '../src/modules/auth/schemas/auth-code.schema.js';
import { LoginAttempt } from '../src/modules/auth/schemas/login-attempt.schema.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeAuthCodes } from './support/fake-auth-codes.js';
import { createFakeLoginAttempts } from './support/fake-login-attempts.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

// 시험을 빠르게 하려고 bcrypt 비용만 4로 낮춘다(운영은 12)
vi.mock('bcrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcrypt')>();
  return {
    ...actual,
    hash: (data: string | Buffer, cost: number | string) =>
      actual.hash(data, typeof cost === 'number' ? Math.min(cost, 4) : cost),
  };
});

const BASE = (path: string) => `/api/v1${path}`;
const SEND = BASE(PATHS.recoverySendCode);
const FIND = BASE(PATHS.findId);
const RESET = BASE(PATHS.passwordReset);
const SIGNUP_SEND = BASE(PATHS.emailSendCode);

const EMAIL = 'student@example.com';
const NEW_PASSWORD = 'NewPassw0rd';
const START = new Date('2026-01-01T00:00:00Z');

interface UserRow {
  sessionVersion?: number;
  _id: Types.ObjectId;
  email: string;
  passwordHash: string | null;
  deletedAt: Date | null;
}

describe('아이디 찾기 · 비밀번호 재설정 HTTP 흐름 (DB와 메일 발송만 대역)', () => {
  let app: INestApplication;
  let tokens: TokenService;
  const users: UserRow[] = [];
  const recovery: { to: string; code: string }[] = [];
  const signupCodes: { to: string; code: string }[] = [];
  const noAccount: string[] = [];
  const authCodes = createFakeAuthCodes();
  const fakeRefresh = createFakeRefreshTokens();
  const loginAttempts = createFakeLoginAttempts();
  // 로그인이 비밀번호를 확인한 뒤(lastLoginAt을 적을 때) 한 번 실행할 일
  let afterPasswordCheck: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    stubAppEnv();
    const mail: MailSender = {
      sendVerificationCode: (to, code) => {
        signupCodes.push({ to, code });
        return Promise.resolve();
      },
      sendAlreadyRegistered: () => Promise.resolve(),
      sendRecoveryCode: (to, code) => {
        recovery.push({ to, code });
        return Promise.resolve();
      },
      sendNoAccount: (to) => {
        noAccount.push(to);
        return Promise.resolve();
      },
    };
    // 이메일로 찾기(계정 찾기) · id로 찾기(토큰 검사) 둘 다
    const find = (f: { email?: string; deletedAt?: null; _id?: Types.ObjectId }) =>
      users.find((u) =>
        f._id ? u._id.equals(f._id) : u.email === f.email && u.deletedAt === f.deletedAt,
      ) ?? null;
    const usersModel = {
      exists: (f: { email: string; deletedAt: null }) =>
        Promise.resolve(find(f) ? { _id: find(f)!._id } : null),
      findOne: (f: { email?: string; deletedAt?: null; _id?: Types.ObjectId }) => ({
        lean: () => Promise.resolve(find(f)),
      }),
      updateOne: (
        f: { _id: Types.ObjectId },
        update: { $set: Partial<UserRow>; $inc?: { sessionVersion?: number } },
      ) => {
        const row = users.find((u) => u._id.equals(f._id));
        if (row) Object.assign(row, update.$set);
        if (row && update.$inc?.sessionVersion) {
          row.sessionVersion = (row.sessionVersion ?? 0) + update.$inc.sessionVersion;
        }
        const hook = 'lastLoginAt' in update.$set ? afterPasswordCheck : undefined;
        afterPasswordCheck = undefined;
        return (hook ? hook() : Promise.resolve()).then(() => ({ matchedCount: row ? 1 : 0 }));
      },
    };
    const moduleRef = await createAppModuleBuilder()
      .overrideProvider(getModelToken(User.name))
      .useValue(usersModel)
      .overrideProvider(getModelToken(AuthCode.name))
      .useValue(authCodes.model)
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(fakeRefresh.model)
      .overrideProvider(getModelToken(LoginAttempt.name))
      .useValue(loginAttempts.model)
      .overrideProvider(MAIL_SENDER)
      .useValue(mail)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    tokens = moduleRef.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    users.length = 0;
    recovery.length = 0;
    signupCodes.length = 0;
    noAccount.length = 0;
    authCodes.rows.length = 0;
    fakeRefresh.rows.length = 0;
    loginAttempts.rows.length = 0;
    afterPasswordCheck = undefined;
    users.push({ _id: new Types.ObjectId(), email: EMAIL, passwordHash: 'old', deletedAt: null });
  });
  afterEach(() => vi.useRealTimers());

  const post = (path: string, body?: object) => request(app.getHttpServer()).post(path).send(body);
  const code = () => recovery.at(-1)!.code;

  it('가입한 이메일엔 인증번호를, 아닌 이메일엔 「계정 없음」 메일을 보내고 응답은 같다', async () => {
    const a = await post(SEND, { email: EMAIL });
    const b = await post(SEND, { email: 'nobody@example.com' });
    expect([a.status, b.status]).toEqual([204, 204]);
    expect(recovery.map((m) => m.to)).toEqual([EMAIL]);
    expect(noAccount).toEqual(['nobody@example.com']);
  });

  it('아이디 찾기: 인증번호가 맞으면 아이디(가입 이메일)를 알려 주고, 같은 인증번호는 다시 못 쓴다', async () => {
    await post(SEND, { email: 'Student@Example.com ' });
    const ok = await post(FIND, { email: EMAIL, code: code() });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ data: { id: EMAIL } });
    const again = await post(FIND, { email: EMAIL, code: code() });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe(ERROR_CODES.EMAIL_CODE_INVALID);
  });

  it('틀린 인증번호는 남은 횟수를 알려 주고, 다 쓰면 잠긴다', async () => {
    await post(SEND, { email: EMAIL });
    const wrong = code() === '000000' ? '111111' : '000000';
    const first = await post(FIND, { email: EMAIL, code: wrong });
    expect(first.status).toBe(400);
    expect(first.body.attemptsLeft).toBe(EMAIL_CODE_MAX_ATTEMPTS - 1);
    for (let i = 1; i < EMAIL_CODE_MAX_ATTEMPTS; i++)
      await post(FIND, { email: EMAIL, code: wrong });
    const locked = await post(FIND, { email: EMAIL, code: code() });
    expect(locked.status).toBe(429);
  });

  it('가입 인증번호로는 계정 찾기를 할 수 없다(목적이 다르다)', async () => {
    await post(SIGNUP_SEND, { email: 'new@example.com' });
    const res = await post(FIND, { email: 'new@example.com', code: signupCodes.at(-1)!.code });
    expect(res.status).toBe(400);
  });

  it('비밀번호 재설정: 아이디와 이메일이 다르면 거절하고, 맞으면 바꾼 뒤 모든 기기 로그인을 끊는다', async () => {
    const user = users[0]!;
    const before = await tokens.issue(user._id.toString());
    await post(SEND, { email: EMAIL });
    const mismatch = await post(RESET, {
      id: EMAIL,
      email: 'other@example.com',
      code: code(),
      password: NEW_PASSWORD,
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe(ERROR_CODES.VALIDATION);
    expect(user.passwordHash).toBe('old');

    const res = await post(RESET, {
      id: EMAIL,
      email: EMAIL,
      code: code(),
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(204);
    expect(await compare(NEW_PASSWORD, user.passwordHash!)).toBe(true);
    expect(fakeRefresh.rows.every((r) => r.revokedAt !== null)).toBe(true);
    // 재설정 전에 받은 access 토큰도 만료 전에 바로 막힌다
    const me = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${before.accessToken}`);
    expect(me.status).toBe(401);
  });

  it('서울 자정이 지나면 하루 횟수를 다시 센다(24시간을 기다리지 않는다)', async () => {
    expect(nextSeoulMidnight(new Date('2026-01-01T14:59:59Z')).toISOString()).toBe(
      '2026-01-01T15:00:00.000Z',
    );
    expect(nextSeoulMidnight(new Date('2026-01-01T15:00:00Z')).toISOString()).toBe(
      '2026-01-02T15:00:00.000Z',
    );
    const lateNight = new Date('2026-01-01T14:50:00Z'); // 서울 23:50
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(lateNight.getTime() + i * 61_000));
      expect((await post(SEND, { email: EMAIL })).status).toBe(204);
    }
    expect((await post(SEND, { email: EMAIL })).status).toBe(429);
    vi.setSystemTime(new Date('2026-01-01T15:00:00Z')); // 서울 00:00
    expect((await post(SEND, { email: EMAIL })).status).toBe(204);
  });

  it('재설정에서 refresh 토큰 줄 폐기가 실패해도, 비밀번호와 함께 끊은 시각이 적혀 예전 토큰은 거절된다', async () => {
    const user = users[0]!;
    const before = await tokens.issue(user._id.toString());
    vi.setSystemTime(new Date(START.getTime() + 1000));
    await post(SEND, { email: EMAIL });
    const updateMany = fakeRefresh.model.updateMany;
    fakeRefresh.model.updateMany = () => Promise.reject(new Error('DB 쓰기 실패'));
    try {
      const res = await post(RESET, {
        id: EMAIL,
        email: EMAIL,
        code: code(),
        password: NEW_PASSWORD,
      });
      expect(res.status).toBe(500);
    } finally {
      fakeRefresh.model.updateMany = updateMany;
    }
    expect(await compare(NEW_PASSWORD, user.passwordHash!)).toBe(true);
    const me = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${before.accessToken}`);
    expect(me.status).toBe(401);
    expect((await post(BASE(PATHS.refresh), { refreshToken: before.refreshToken })).status).toBe(
      401,
    );
  });

  it('재설정 전에 끝난 로그인의 토큰은, 재설정의 끊은 시각이 그보다 앞서고 refresh 폐기가 실패해도 거절된다', async () => {
    const user = users[0]!;
    vi.setSystemTime(new Date(START.getTime() + 1000));
    const before = await tokens.issue(user._id.toString()); // 재설정이 시각을 정한 뒤 만들어진 토큰
    vi.setSystemTime(START); // 재설정의 끊은 시각은 그보다 앞선다
    await post(SEND, { email: EMAIL });
    const updateMany = fakeRefresh.model.updateMany;
    fakeRefresh.model.updateMany = () => Promise.reject(new Error('DB 쓰기 실패'));
    try {
      const res = await post(RESET, {
        id: EMAIL,
        email: EMAIL,
        code: code(),
        password: NEW_PASSWORD,
      });
      expect(res.status).toBe(500);
    } finally {
      fakeRefresh.model.updateMany = updateMany;
    }
    const me = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${before.accessToken}`);
    expect(me.status).toBe(401);
    expect((await post(BASE(PATHS.refresh), { refreshToken: before.refreshToken })).status).toBe(
      401,
    );
  });

  it('예전 비밀번호로 로그인하는 도중(확인 뒤 · 발급 전) 재설정이 끝나면 그 로그인은 401이고 토큰이 남지 않는다', async () => {
    const user = users[0]!;
    user.passwordHash = await hash('OldPassw0rd', 4);
    await post(SEND, { email: EMAIL });
    const resetCode = code();
    afterPasswordCheck = async () => {
      vi.setSystemTime(new Date(START.getTime() + 1000));
      const reset = await post(RESET, {
        id: EMAIL,
        email: EMAIL,
        code: resetCode,
        password: NEW_PASSWORD,
      });
      expect(reset.status).toBe(204);
    };

    const login = await post(BASE(PATHS.emailLogin), { email: EMAIL, password: 'OldPassw0rd' });
    expect(login.status).toBe(401);
    expect(fakeRefresh.rows.filter((r) => r.revokedAt === null)).toHaveLength(0);
    // 새 비밀번호로는 로그인된다
    vi.setSystemTime(new Date(START.getTime() + 2000));
    const again = await post(BASE(PATHS.emailLogin), { email: EMAIL, password: NEW_PASSWORD });
    expect(again.status).toBe(200);
  });

  it('재설정의 끊은 시각이 로그인 확인보다 앞서도, 예전 비밀번호 해시로 확인한 로그인은 401이다', async () => {
    const user = users[0]!;
    user.passwordHash = await hash('OldPassw0rd', 4);
    await post(SEND, { email: EMAIL });
    const resetCode = code();
    // 로그인이 예전 해시를 읽고 확인하는 사이에 재설정이 반영된다. 재설정의 시각은 로그인 확인 시각보다 앞선다
    // (재설정이 시각을 정한 뒤 DB 반영 전에 로그인이 예전 해시를 읽은 경우)
    afterPasswordCheck = async () => {
      vi.setSystemTime(new Date(START.getTime() - 1000));
      const reset = await post(RESET, {
        id: EMAIL,
        email: EMAIL,
        code: resetCode,
        password: NEW_PASSWORD,
      });
      expect(reset.status).toBe(204);
      vi.setSystemTime(START);
    };

    const login = await post(BASE(PATHS.emailLogin), { email: EMAIL, password: 'OldPassw0rd' });
    expect(login.status).toBe(401);
    expect(fakeRefresh.rows.filter((r) => r.revokedAt === null)).toHaveLength(0);
  });

  it('계정 찾기 인증번호는 하루 3번까지만 보낸다(인증번호를 계속 받아 맞혀 보는 공격을 막는다)', async () => {
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(START.getTime() + i * 61_000));
      expect((await post(SEND, { email: EMAIL })).status).toBe(204);
    }
    vi.setSystemTime(new Date(START.getTime() + 3 * 61_000 + 60 * 60 * 1000)); // 1시간 뒤에도
    const blocked = await post(SEND, { email: EMAIL });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(recovery).toHaveLength(3);
    vi.setSystemTime(nextSeoulMidnight(START)); // 서울 자정이 지나면 다시
    expect((await post(SEND, { email: EMAIL })).status).toBe(204);
  });

  it('서울 자정 직전에 처음 보낸 인증번호는 자정 뒤 만료까지 남고, 자정을 넘어도 재발송 간격은 지킨다', async () => {
    vi.setSystemTime(new Date('2026-01-01T14:59:30Z')); // 서울 23:59:30
    expect((await post(SEND, { email: EMAIL })).status).toBe(204);
    const row = authCodes.rows.find((r) => r.purpose === 'recovery')!;
    expect(row.windowEndsAt.toISOString()).toBe('2026-01-01T15:00:00.000Z');
    // 구간(자정)보다 번호 만료(10분 뒤)가 늦으므로 보관은 만료까지
    expect(row.retainUntil.getTime()).toBe(row.expiresAt.getTime());
    expect(row.expiresAt.toISOString()).toBe('2026-01-01T15:09:30.000Z');

    vi.setSystemTime(new Date('2026-01-01T15:00:10Z')); // 자정 10초 뒤: 새 구간이지만 마지막 발송 40초 뒤
    expect((await post(SEND, { email: EMAIL })).status).toBe(429);
    vi.setSystemTime(new Date('2026-01-01T15:00:31Z')); // 60초가 지나면 새 구간으로 다시 센다
    expect((await post(SEND, { email: EMAIL })).status).toBe(204);
    expect(row.sendCount).toBe(1);
    // 같은 이메일로 받은 번호로 계정 찾기가 된다(자정을 넘긴 번호도 쓸 수 있다)
    expect((await post(FIND, { email: EMAIL, code: code() })).status).toBe(200);
  });

  it('새 비밀번호도 가입과 같은 규칙(영문 + 숫자 8자 이상)을 지킨다', async () => {
    await post(SEND, { email: EMAIL });
    const res = await post(RESET, { id: EMAIL, email: EMAIL, code: code(), password: 'short' });
    expect(res.status).toBe(400);
    expect(users[0]!.passwordHash).toBe('old');
  });
});
