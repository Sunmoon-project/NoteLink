import { type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { AuthTokens, ERROR_CODES, PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
} from '../src/modules/auth/app-login/email-code.service.js';
import { LOGIN_MAX_ATTEMPTS } from '../src/modules/auth/app-login/login-throttle.service.js';
import {
  MAIL_SENDER,
  type MailSender,
  MailUnavailableError,
} from '../src/modules/mail/mail-sender.js';
import { AuthCode } from '../src/modules/auth/schemas/auth-code.schema.js';
import { LoginAttempt } from '../src/modules/auth/schemas/login-attempt.schema.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeAuthCodes } from './support/fake-auth-codes.js';
import { createFakeLoginAttempts } from './support/fake-login-attempts.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

// 시험을 빠르게 하려고 bcrypt 비용만 4로 낮춘다(운영은 12). 해시 · 비교 동작 자체는 실제 bcrypt를 쓴다
vi.mock('bcrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcrypt')>();
  return {
    ...actual,
    hash: (data: string | Buffer, cost: number | string) =>
      actual.hash(data, typeof cost === 'number' ? Math.min(cost, 4) : cost),
  };
});

const BASE = (path: string) => `/api/v1${path}`;
const SEND = BASE(PATHS.emailSendCode);
const VERIFY = BASE(PATHS.emailVerifyCode);
const SIGNUP = BASE(PATHS.emailSignup);
const LOGIN = BASE(PATHS.emailLogin);

const EMAIL = 'student@example.com';
const PASSWORD = 'Passw0rdOK';
const START = new Date('2026-01-01T00:00:00Z');

interface UserRow {
  sessionVersion?: number;
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
  socialAccounts: unknown[];
  lastLoginAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
}

describe('이메일 가입 · 로그인 HTTP 전체 흐름 (DB와 메일 발송만 대역)', () => {
  let app: INestApplication;
  let tokens: TokenService;
  const users: UserRow[] = [];
  const sent: { to: string; code: string }[] = [];
  const notices: string[] = [];
  const authCodes = createFakeAuthCodes();
  const loginAttempts = createFakeLoginAttempts();
  const fakeRefresh = createFakeRefreshTokens();
  const refreshRows = fakeRefresh.rows;
  /** true이면 메일 발송 수단을 쓸 수 없는 상태를 흉내 낸다 */
  let mailDown = false;

  beforeAll(async () => {
    stubAppEnv();
    const mail: MailSender = {
      sendVerificationCode: (to, code) => {
        if (mailDown) return Promise.reject(new MailUnavailableError('테스트'));
        sent.push({ to, code });
        return Promise.resolve();
      },
      sendAlreadyRegistered: (to) => {
        if (mailDown) return Promise.reject(new MailUnavailableError('테스트'));
        notices.push(to);
        return Promise.resolve();
      },
      sendRecoveryCode: () => Promise.resolve(),
      sendNoAccount: () => Promise.resolve(),
    };
    const usersModel = {
      exists: (f: { email: string; deletedAt: null }) =>
        Promise.resolve(
          users.find((u) => u.email === f.email && u.deletedAt === f.deletedAt)
            ? { _id: new Types.ObjectId() }
            : null,
        ),
      create: (data: Partial<UserRow>) => {
        if (data.email && users.some((u) => u.email === data.email)) {
          return Promise.reject(
            Object.assign(new Error('E11000'), { code: 11000, keyPattern: { email: 1 } }),
          );
        }
        const row: UserRow = {
          _id: new Types.ObjectId(),
          email: null,
          passwordHash: null,
          nickname: '',
          role: 'user',
          learnerType: null,
          pointBalance: 0,
          settings: {},
          status: 'active',
          interestCategoryIds: [],
          socialAccounts: [],
          lastLoginAt: null,
          createdAt: new Date(),
          deletedAt: null,
          ...data,
        };
        users.push(row);
        return Promise.resolve(row);
      },
      // 이메일로 찾기(로그인) · id로 찾기(토큰 검사) 둘 다
      findOne: (f: { email?: string; deletedAt?: null; _id?: Types.ObjectId }) => ({
        lean: () =>
          Promise.resolve(
            users.find((u) =>
              f._id ? u._id.equals(f._id) : u.email === f.email && u.deletedAt === f.deletedAt,
            ) ?? null,
          ),
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
        return Promise.resolve({ matchedCount: row ? 1 : 0 });
      },
    };
    const moduleRef = await createAppModuleBuilder()
      .overrideProvider(getModelToken(User.name))
      .useValue(usersModel)
      .overrideProvider(getModelToken(AuthCode.name))
      .useValue(authCodes.model)
      .overrideProvider(getModelToken(LoginAttempt.name))
      .useValue(loginAttempts.model)
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(fakeRefresh.model)
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
    sent.length = 0;
    notices.length = 0;
    authCodes.rows.length = 0;
    loginAttempts.rows.length = 0;
    refreshRows.length = 0;
    mailDown = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const http = () => app.getHttpServer();
  const post = (path: string, body?: object) => request(http()).post(path).send(body);
  const lastCode = () => sent.at(-1)!.code;

  /** 인증번호를 받아 확인하고 가입 증표를 얻는다 */
  async function verifiedToken(email = EMAIL): Promise<string> {
    await post(SEND, { email });
    const res = await post(VERIFY, { email, code: lastCode() });
    return res.body.data.verificationToken as string;
  }

  /** 가입까지 끝낸다 */
  async function registered(email = EMAIL, password = PASSWORD) {
    const token = await verifiedToken(email);
    return post(SIGNUP, { verificationToken: token, password });
  }

  describe('전체 흐름', () => {
    it('인증번호 받기 → 확인 → 가입 → 로그인 → 토큰으로 갱신까지 된다', async () => {
      const sendRes = await post(SEND, { email: EMAIL });
      expect(sendRes.status).toBe(204);
      expect(sent).toHaveLength(1);

      const verifyRes = await post(VERIFY, { email: EMAIL, code: lastCode() });
      expect(verifyRes.status).toBe(200);
      const { verificationToken, expiresInSeconds } = verifyRes.body.data;
      expect(expiresInSeconds).toBe(600);

      const signupRes = await post(SIGNUP, { verificationToken, password: PASSWORD });
      expect(signupRes.status).toBe(204);

      const loginRes = await post(LOGIN, { email: EMAIL, password: PASSWORD });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.user.email).toBe(EMAIL);

      const refreshRes = await post(BASE('/auth/refresh'), {
        refreshToken: loginRes.body.data.refreshToken,
      });
      expect(refreshRes.status).toBe(200);
    });

    it('가입 후 로그인한 토큰으로 보호된 주소를 통과한다 (access 토큰이 유효하다)', async () => {
      await registered();
      const login = await post(LOGIN, { email: EMAIL, password: PASSWORD });

      const { userId } = await tokens.verifyAccess(login.body.data.accessToken);

      expect(userId).toBe(login.body.data.user._id);
    });

    it('대소문자와 앞뒤 공백이 달라도 같은 계정이다 (이메일은 소문자로 맞춘다)', async () => {
      await registered('Student@Example.COM');

      const res = await post(LOGIN, { email: '  STUDENT@example.com ', password: PASSWORD });

      expect(res.status).toBe(200);
      expect(users).toHaveLength(1);
      expect(users[0]!.email).toBe('student@example.com');
    });
  });

  describe('POST /auth/email/send-code', () => {
    it('204이고 본문이 없다 (인증번호를 응답에 싣지 않는다)', async () => {
      const res = await post(SEND, { email: EMAIL });

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(JSON.stringify(res.body)).not.toContain(lastCode());
    });

    it('응답을 캐시하지 않게 한다', async () => {
      const res = await post(SEND, { email: EMAIL });

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('이미 가입한 이메일도 새 이메일과 응답이 똑같다 (상태 · 본문 · 헤더)', async () => {
      await registered('taken@example.com');
      sent.length = 0;
      vi.setSystemTime(new Date(START.getTime() + 2 * EMAIL_CODE_RESEND_COOLDOWN_MS));

      const taken = await post(SEND, { email: 'taken@example.com' });
      const fresh = await post(SEND, { email: 'fresh@example.com' });

      expect(taken.status).toBe(fresh.status);
      expect(taken.text).toBe(fresh.text);
      expect(taken.headers['cache-control']).toBe(fresh.headers['cache-control']);
      // 달라지는 것은 메일 내용뿐이다
      expect(notices).toEqual(['taken@example.com']);
      expect(sent.map((m) => m.to)).toEqual(['fresh@example.com']);
    });

    it('다시 빨리 보내면 429 RATE_LIMITED와 retryAfterSeconds', async () => {
      await post(SEND, { email: EMAIL });

      const res = await post(SEND, { email: EMAIL });

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ code: ERROR_CODES.RATE_LIMITED, retryAfterSeconds: 60 });
    });

    it.each([
      ['본문 없음', undefined],
      ['이메일 없음', {}],
      ['이메일 형식 오류', { email: 'not-an-email' }],
      ['이메일이 숫자', { email: 123 }],
    ])('%s이면 400 VALIDATION_FAILED이다', async (_reason, body) => {
      const res = await post(SEND, body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: ERROR_CODES.VALIDATION, message: expect.any(String) });
      expect(sent).toHaveLength(0);
    });

    it('GET은 받지 않는다', async () => {
      const res = await request(http()).get(SEND);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /auth/email/verify-code', () => {
    it('맞는 인증번호면 200 { data: { verificationToken, expiresInSeconds } }', async () => {
      await post(SEND, { email: EMAIL });

      const res = await post(VERIFY, { email: EMAIL, code: lastCode() });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(Object.keys(res.body.data).sort()).toEqual(['expiresInSeconds', 'verificationToken']);
    });

    it('응답을 캐시하지 않게 한다 (증표가 들어 있다)', async () => {
      await post(SEND, { email: EMAIL });

      const res = await post(VERIFY, { email: EMAIL, code: lastCode() });

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('틀리면 400 EMAIL_CODE_INVALID와 남은 횟수', async () => {
      await post(SEND, { email: EMAIL });
      const wrong = lastCode() === '000000' ? '000001' : '000000';

      const res = await post(VERIFY, { email: EMAIL, code: wrong });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: ERROR_CODES.EMAIL_CODE_INVALID,
        attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - 1,
      });
    });

    it('5번 틀리면 429 EMAIL_CODE_LOCKED', async () => {
      await post(SEND, { email: EMAIL });
      const wrong = lastCode() === '000000' ? '000001' : '000000';
      let res = await post(VERIFY, { email: EMAIL, code: wrong });
      for (let i = 1; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
        res = await post(VERIFY, { email: EMAIL, code: wrong });
      }

      expect(res.status).toBe(429);
      expect(res.body.code).toBe(ERROR_CODES.EMAIL_CODE_LOCKED);
    });

    it('받은 적 없는 이메일은 같은 400이되 남은 횟수는 없다', async () => {
      const res = await post(VERIFY, { email: 'nobody@example.com', code: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ERROR_CODES.EMAIL_CODE_INVALID);
      expect(res.body).not.toHaveProperty('attemptsLeft');
    });

    it.each([
      ['코드 5자리', { email: EMAIL, code: '12345' }],
      ['코드에 문자', { email: EMAIL, code: '12345a' }],
      ['코드가 숫자 타입', { email: EMAIL, code: 123456 }],
      ['코드 없음', { email: EMAIL }],
      ['이메일 형식 오류', { email: 'nope', code: '123456' }],
    ])('%s이면 400 VALIDATION_FAILED이다', async (_reason, body) => {
      const res = await post(VERIFY, body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ERROR_CODES.VALIDATION);
    });
  });

  describe('POST /auth/email/signup', () => {
    it('204이고 본문이 없다 (토큰을 주지 않는다)', async () => {
      const token = await verifiedToken();

      const res = await post(SIGNUP, { verificationToken: token, password: PASSWORD });

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('이메일을 요청으로 받지 않는다 (본문에 다른 이메일을 넣어도 증표의 이메일로 가입된다)', async () => {
      const token = await verifiedToken('real@example.com');

      await post(SIGNUP, {
        verificationToken: token,
        password: PASSWORD,
        email: 'attacker@evil.com',
      });

      expect(users.map((u) => u.email)).toEqual(['real@example.com']);
    });

    it('같은 증표로 두 번 가입하면 두 번째는 401 EMAIL_PROOF_INVALID', async () => {
      const token = await verifiedToken();
      await post(SIGNUP, { verificationToken: token, password: PASSWORD });

      const res = await post(SIGNUP, { verificationToken: token, password: PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(ERROR_CODES.EMAIL_PROOF_INVALID);
      expect(users).toHaveLength(1);
    });

    it('수명이 지난 증표는 401 EMAIL_PROOF_EXPIRED', async () => {
      const token = await verifiedToken();
      vi.setSystemTime(new Date(START.getTime() + 11 * 60 * 1000));

      const res = await post(SIGNUP, { verificationToken: token, password: PASSWORD });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(ERROR_CODES.EMAIL_PROOF_EXPIRED);
    });

    it('위조된 증표는 401 EMAIL_PROOF_INVALID', async () => {
      const token = await verifiedToken();

      const res = await post(SIGNUP, {
        verificationToken: `${token.slice(0, -3)}abc`,
        password: PASSWORD,
      });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(ERROR_CODES.EMAIL_PROOF_INVALID);
      expect(users).toHaveLength(0);
    });

    it('이미 가입한 이메일은 409 EMAIL_TAKEN (인증을 마친 본인에게만 알린다)', async () => {
      const token = await verifiedToken();
      users.push({ ...userRow(), email: EMAIL });

      const res = await post(SIGNUP, { verificationToken: token, password: PASSWORD });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(ERROR_CODES.EMAIL_TAKEN);
    });

    it.each([
      ['비밀번호 7자', 'abc1234'],
      ['공백 포함', 'abcd 1234'],
      ['숫자 없음', 'abcdefghij'],
      ['영문 없음', '1234567890'],
      ['65자', `${'a'.repeat(64)}1`],
    ])(
      '비밀번호가 %s이면 400 VALIDATION_FAILED이고 증표는 소비되지 않는다',
      async (_r, password) => {
        const token = await verifiedToken();

        const bad = await post(SIGNUP, { verificationToken: token, password });
        const good = await post(SIGNUP, { verificationToken: token, password: PASSWORD });

        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe(ERROR_CODES.VALIDATION);
        expect(good.status).toBe(204); // 형식 검증에서 걸렸으니 증표는 그대로 쓸 수 있다
      },
    );

    it.each([
      ['증표 없음', { password: PASSWORD }],
      ['증표 형식 오류', { verificationToken: 'nope', password: PASSWORD }],
      ['본문 없음', undefined],
    ])('%s이면 400 VALIDATION_FAILED이다', async (_reason, body) => {
      const res = await post(SIGNUP, body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ERROR_CODES.VALIDATION);
    });

    it('오류 응답에 비밀번호 · 증표를 되돌려 주지 않는다', async () => {
      const token = await verifiedToken();
      users.push({ ...userRow(), email: EMAIL });

      const res = await post(SIGNUP, { verificationToken: token, password: PASSWORD });

      expect(res.text).not.toContain(PASSWORD);
      expect(res.text).not.toContain(token);
    });
  });

  describe('POST /auth/email/login', () => {
    it('200 { data: { accessToken, refreshToken, user } } 이고 앱의 AuthTokens 스키마를 통과한다', async () => {
      await registered();

      const res = await post(LOGIN, { email: EMAIL, password: PASSWORD });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(AuthTokens.safeParse(res.body.data).success).toBe(true);
    });

    it('응답을 캐시하지 않게 한다 (토큰이 들어 있다)', async () => {
      await registered();

      const res = await post(LOGIN, { email: EMAIL, password: PASSWORD });

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('응답에 비밀번호 해시 · 소셜 연동 정보가 없다', async () => {
      await registered();

      const res = await post(LOGIN, { email: EMAIL, password: PASSWORD });

      expect(res.text).not.toMatch(/passwordHash|\$2[aby]\$|socialAccounts|providerUid/);
    });

    it('refresh 토큰은 DB에 해시로만 저장된다', async () => {
      await registered();

      const res = await post(LOGIN, { email: EMAIL, password: PASSWORD });

      expect(refreshRows).toHaveLength(1);
      expect(refreshRows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(refreshRows)).not.toContain(res.body.data.refreshToken);
    });

    it('틀린 비밀번호는 401 INVALID_CREDENTIALS이고 토큰 만료 코드가 아니다', async () => {
      await registered();

      const res = await post(LOGIN, { email: EMAIL, password: 'WrongPassw0rd' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        code: ERROR_CODES.INVALID_CREDENTIALS,
        message: expect.any(String),
      });
      expect(res.body.code).not.toBe(ERROR_CODES.TOKEN_EXPIRED);
    });

    it('없는 이메일도 틀린 비밀번호와 응답이 완전히 같다 (응답으로 가입 여부를 알 수 없다)', async () => {
      await registered();

      const wrongPw = await post(LOGIN, { email: EMAIL, password: 'WrongPassw0rd' });
      const noUser = await post(LOGIN, { email: 'nobody@example.com', password: 'WrongPassw0rd' });

      expect(noUser.status).toBe(wrongPw.status);
      expect(noUser.body).toEqual(wrongPw.body);
    });

    it('5번 틀리면 6번째는 429 LOGIN_LOCKED이고, 맞는 비밀번호도 거부한다', async () => {
      await registered();
      for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
        await post(LOGIN, { email: EMAIL, password: 'WrongPassw0rd' });
      }

      const wrong = await post(LOGIN, { email: EMAIL, password: 'WrongPassw0rd' });
      const right = await post(LOGIN, { email: EMAIL, password: PASSWORD });

      expect(wrong.status).toBe(429);
      expect(wrong.body).toMatchObject({ code: ERROR_CODES.LOGIN_LOCKED, retryAfterSeconds: 900 });
      expect(right.status).toBe(429);
    });

    it('없는 이메일도 똑같이 5번 뒤에 잠긴다', async () => {
      for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
        await post(LOGIN, { email: 'nobody@example.com', password: 'WrongPassw0rd' });
      }

      const res = await post(LOGIN, { email: 'nobody@example.com', password: 'WrongPassw0rd' });

      expect(res.status).toBe(429);
      expect(res.body.code).toBe(ERROR_CODES.LOGIN_LOCKED);
    });

    it.each([
      ['본문 없음', undefined],
      ['이메일 없음', { password: PASSWORD }],
      ['비밀번호 없음', { email: EMAIL }],
      ['이메일 형식 오류', { email: 'nope', password: PASSWORD }],
    ])('%s이면 400 VALIDATION_FAILED이다', async (_reason, body) => {
      const res = await post(LOGIN, body);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(ERROR_CODES.VALIDATION);
    });

    it('형식 오류 요청은 시도 횟수를 쓰지 않는다 (잘못된 요청으로 남의 계정을 잠그지 못한다)', async () => {
      for (let i = 0; i < 10; i++) await post(LOGIN, { email: EMAIL });

      expect(loginAttempts.rows).toHaveLength(0);
    });
  });

  describe('메일을 보낼 수 없을 때', () => {
    it('503 MAIL_UNAVAILABLE이다', async () => {
      mailDown = true;

      const res = await post(SEND, { email: EMAIL });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe(ERROR_CODES.MAIL_UNAVAILABLE);
    });

    it('이미 가입한 이메일도 똑같이 503이다 (응답으로 가입 여부를 구분할 수 없다)', async () => {
      await registered('taken@example.com');
      vi.setSystemTime(new Date(START.getTime() + 2 * EMAIL_CODE_RESEND_COOLDOWN_MS));
      mailDown = true;

      const taken = await post(SEND, { email: 'taken@example.com' });
      const fresh = await post(SEND, { email: 'fresh@example.com' });

      expect(taken.status).toBe(503);
      expect(taken.body).toEqual(fresh.body);
    });
  });
});

const userRow = (): UserRow => ({
  _id: new Types.ObjectId(),
  email: null,
  passwordHash: 'hash',
  nickname: '기존',
  role: 'user',
  learnerType: null,
  pointBalance: 0,
  settings: {},
  status: 'active',
  interestCategoryIds: [],
  socialAccounts: [],
  lastLoginAt: null,
  createdAt: new Date(),
  deletedAt: null,
});
