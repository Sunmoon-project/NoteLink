import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcrypt';
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_LOGIN_ERRORS,
  AppSignupService,
  PASSWORD_HASH_COST,
} from '../src/modules/auth/app-login/app-signup.service.js';
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_SEND_WINDOW_MS,
  EMAIL_PROOF_TTL_MS,
  EmailCodeService,
} from '../src/modules/auth/app-login/email-code.service.js';
import { EmailProofService } from '../src/modules/auth/app-login/email-proof.service.js';
import {
  type MailSender,
  MailUnavailableError,
} from '../src/modules/mail/mail-sender.js';
import { createFakeAuthCodes } from './support/fake-auth-codes.js';

const JWT_CONFIG = {
  accessSecret: 'test-access-secret-0123456789abcdef',
  refreshSecret: 'test-refresh-secret-0123456789abcdef',
  accessTTL: '15m',
  refreshTTL: '14d',
} as never;

const EMAIL = 'student@example.com';
const START = new Date('2026-01-01T00:00:00Z');
const PASSWORD = 'Passw0rdOK';
/** 시험에서는 빠른 비용으로 해시한다(운영은 12) */
const TEST_COST = 4;

interface UserRow {
  _id: Types.ObjectId;
  email: string | null;
  passwordHash: string | null;
  nickname: string;
  deletedAt: Date | null;
}

function setup(options: { mailFails?: boolean; random?: (max: number) => number } = {}) {
  const auth = createFakeAuthCodes();
  const users: UserRow[] = [];
  const mails = {
    codes: [] as { to: string; code: string }[],
    alreadyRegistered: [] as string[],
  };
  const mail: MailSender = {
    sendVerificationCode: (to, code) => {
      if (options.mailFails) return Promise.reject(new MailUnavailableError('x'));
      mails.codes.push({ to, code });
      return Promise.resolve();
    },
    sendAlreadyRegistered: (to) => {
      if (options.mailFails) return Promise.reject(new MailUnavailableError('x'));
      mails.alreadyRegistered.push(to);
      return Promise.resolve();
    },
  };
  const usersModel = {
    exists: (f: { email: string; deletedAt: null }) =>
      Promise.resolve(
        users.find((u) => u.email === f.email && u.deletedAt === f.deletedAt)
          ? { _id: new Types.ObjectId() }
          : null,
      ),
    create: (data: Partial<UserRow>) => {
      // 이메일 유일 인덱스: 탈퇴한 사용자도 포함해 같은 이메일이면 중복 키 오류
      if (data.email && users.some((u) => u.email === data.email)) {
        return Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }));
      }
      const row: UserRow = {
        _id: new Types.ObjectId(),
        email: null,
        passwordHash: null,
        nickname: '',
        deletedAt: null,
        ...data,
      };
      users.push(row);
      return Promise.resolve(row);
    },
  };
  const codes = new EmailCodeService(auth.model as never, JWT_CONFIG, options.random);
  const proofs = new EmailProofService(new JwtService(), JWT_CONFIG);
  const service = new AppSignupService(codes, proofs, mail, usersModel as never, TEST_COST);
  return { service, codes, proofs, users, mails, auth };
}

/** 오류가 나야 하는 호출에서 던져진 예외의 상태와 본문을 꺼낸다 */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as { getStatus: () => number; getResponse: () => Record<string, unknown> };
    return { status: e.getStatus(), body: e.getResponse() };
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

/** 인증번호를 받아 확인하고 증표까지 얻는다 */
async function verifiedToken(ctx: ReturnType<typeof setup>, email = EMAIL) {
  await ctx.service.sendCode(email);
  const code = ctx.mails.codes.at(-1)!.code;
  return (await ctx.service.verifyCode(email, code)).verificationToken;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AppSignupService.sendCode', () => {
  describe('새 이메일', () => {
    it('인증번호 메일을 보낸다', async () => {
      const { service, mails } = setup();

      await service.sendCode(EMAIL);

      expect(mails.codes).toHaveLength(1);
      expect(mails.codes[0]).toMatchObject({ to: EMAIL, code: expect.stringMatching(/^\d{6}$/) });
      expect(mails.alreadyRegistered).toHaveLength(0);
    });

    it('아무것도 돌려주지 않는다 (응답에 인증번호를 싣지 않는다)', async () => {
      const { service } = setup();

      expect(await service.sendCode(EMAIL)).toBeUndefined();
    });
  });

  describe('이미 가입한 이메일 (가입 여부를 응답으로 알려 주지 않는다)', () => {
    function withUser(ctx: ReturnType<typeof setup>, email = EMAIL) {
      ctx.users.push({
        _id: new Types.ObjectId(),
        email,
        passwordHash: 'hash',
        nickname: '기존',
        deletedAt: null,
      });
    }

    it('인증번호 대신 "이미 가입했다"는 안내 메일을 보낸다', async () => {
      const ctx = setup();
      withUser(ctx);

      await ctx.service.sendCode(EMAIL);

      expect(ctx.mails.alreadyRegistered).toEqual([EMAIL]);
      expect(ctx.mails.codes).toHaveLength(0);
    });

    it('응답은 새 이메일일 때와 똑같다 (둘 다 아무것도 돌려주지 않고 오류도 없다)', async () => {
      const fresh = setup();
      const taken = setup();
      withUser(taken);

      const a = await fresh.service.sendCode(EMAIL);
      const b = await taken.service.sendCode(EMAIL);

      expect(b).toEqual(a);
    });

    it('재발송 간격 제한도 똑같이 걸린다 (제한 응답으로 가입 여부를 구분할 수 없다)', async () => {
      const fresh = setup();
      const taken = setup();
      withUser(taken);
      await fresh.service.sendCode(EMAIL);
      await taken.service.sendCode(EMAIL);

      const a = await failure(fresh.service.sendCode(EMAIL));
      const b = await failure(taken.service.sendCode(EMAIL));

      expect(b).toEqual(a);
      expect(b.status).toBe(429);
    });

    it('구간 한도도 똑같이 걸린다', async () => {
      const fresh = setup();
      const taken = setup();
      withUser(taken);
      for (const ctx of [fresh, taken]) {
        for (let i = 0; i < 5; i++) {
          vi.setSystemTime(new Date(START.getTime() + i * EMAIL_CODE_RESEND_COOLDOWN_MS));
          await ctx.service.sendCode(EMAIL);
        }
      }
      vi.setSystemTime(new Date(START.getTime() + 5 * EMAIL_CODE_RESEND_COOLDOWN_MS));

      const a = await failure(fresh.service.sendCode(EMAIL));
      const b = await failure(taken.service.sendCode(EMAIL));

      expect(b).toEqual(a);
    });

    it('소셜로 가입한 계정(비밀번호 없음)도 이미 가입한 것으로 본다', async () => {
      const ctx = setup();
      ctx.users.push({
        _id: new Types.ObjectId(),
        email: EMAIL,
        passwordHash: null,
        nickname: '소셜',
        deletedAt: null,
      });

      await ctx.service.sendCode(EMAIL);

      expect(ctx.mails.alreadyRegistered).toEqual([EMAIL]);
    });

    it('탈퇴한 계정의 이메일은 가입 가능한 것으로 본다 (인증번호를 보낸다)', async () => {
      const ctx = setup();
      ctx.users.push({
        _id: new Types.ObjectId(),
        email: EMAIL,
        passwordHash: 'hash',
        nickname: '탈퇴',
        deletedAt: new Date(),
      });

      await ctx.service.sendCode(EMAIL);

      expect(ctx.mails.codes).toHaveLength(1);
    });

    it('다른 이메일의 가입 여부는 영향을 주지 않는다', async () => {
      const ctx = setup();
      withUser(ctx, 'other@example.com');

      await ctx.service.sendCode(EMAIL);

      expect(ctx.mails.codes).toHaveLength(1);
    });
  });

  describe('발송 제한', () => {
    it('간격(60초) 안에 다시 요청하면 429 RATE_LIMITED와 남은 시간을 돌려준다', async () => {
      const { service } = setup();
      await service.sendCode(EMAIL);
      vi.setSystemTime(new Date(START.getTime() + 20_000));

      const result = await failure(service.sendCode(EMAIL));

      expect(result.status).toBe(429);
      expect(result.body).toMatchObject({
        code: APP_LOGIN_ERRORS.RATE_LIMITED,
        retryAfterSeconds: 40,
      });
    });

    it('제한에 걸리면 메일을 보내지 않는다', async () => {
      const { service, mails } = setup();
      await service.sendCode(EMAIL);

      await failure(service.sendCode(EMAIL));

      expect(mails.codes).toHaveLength(1);
    });

    it('간격이 지나면 다시 보낼 수 있다', async () => {
      const { service, mails } = setup();
      await service.sendCode(EMAIL);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));

      await service.sendCode(EMAIL);

      expect(mails.codes).toHaveLength(2);
    });

    it('구간 한도(5번)를 넘으면 429이고 문구가 간격 제한과 다르다', async () => {
      const { service } = setup();
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(new Date(START.getTime() + i * EMAIL_CODE_RESEND_COOLDOWN_MS));
        await service.sendCode(EMAIL);
      }
      vi.setSystemTime(new Date(START.getTime() + 5 * EMAIL_CODE_RESEND_COOLDOWN_MS));

      const limit = await failure(service.sendCode(EMAIL));

      vi.setSystemTime(START);
      const fresh = setup();
      await fresh.service.sendCode(EMAIL);
      const cooldown = await failure(fresh.service.sendCode(EMAIL));

      expect(limit.status).toBe(429);
      expect(limit.body['message']).not.toBe(cooldown.body['message']);
      expect(limit.body['retryAfterSeconds']).toBe(
        Math.ceil((EMAIL_CODE_SEND_WINDOW_MS - 5 * EMAIL_CODE_RESEND_COOLDOWN_MS) / 1000),
      );
    });
  });

  describe('메일을 보낼 수 없을 때', () => {
    it('발송 수단 오류는 503 MAIL_UNAVAILABLE로 바꾼다', async () => {
      const { service } = setup({ mailFails: true });

      const result = await failure(service.sendCode(EMAIL));

      expect(result.status).toBe(503);
      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.MAIL_UNAVAILABLE);
    });

    it('이미 가입한 이메일의 안내 메일 실패도 같은 503이다 (응답으로 가입 여부를 구분할 수 없다)', async () => {
      const fresh = setup({ mailFails: true });
      const taken = setup({ mailFails: true });
      taken.users.push({
        _id: new Types.ObjectId(),
        email: EMAIL,
        passwordHash: 'h',
        nickname: 'n',
        deletedAt: null,
      });

      expect(await failure(taken.service.sendCode(EMAIL))).toEqual(
        await failure(fresh.service.sendCode(EMAIL)),
      );
    });

    it('MailUnavailableError가 아닌 오류는 그대로 던진다 (예상 못 한 장애를 503으로 숨기지 않는다)', async () => {
      const ctx = setup();
      const broken = new AppSignupService(
        ctx.codes,
        ctx.proofs,
        {
          sendVerificationCode: () => Promise.reject(new Error('예상 못 한 오류')),
          sendAlreadyRegistered: () => Promise.resolve(),
        },
        { exists: () => Promise.resolve(null) } as never,
        TEST_COST,
      );

      await expect(broken.sendCode(EMAIL)).rejects.toThrow('예상 못 한 오류');
    });
  });

  describe('보안', () => {
    it('오류 응답에 인증번호가 들어 있지 않다', async () => {
      const { service, mails } = setup();
      await service.sendCode(EMAIL);

      const result = await failure(service.sendCode(EMAIL));

      expect(JSON.stringify(result.body)).not.toContain(mails.codes[0]!.code);
    });
  });
});

describe('재시도 시간은 올림으로 알린다 (내림하면 클라이언트가 1초 일찍 다시 눌러 또 거부당한다)', () => {
  it('남은 시간이 1.5초면 2초로 알린다', async () => {
    const { service } = setup();
    await service.sendCode(EMAIL);
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS - 1_500));

    const result = await failure(service.sendCode(EMAIL));

    expect(result.body['retryAfterSeconds']).toBe(2);
  });

  it('남은 시간이 1밀리초여도 1초로 알린다 (0초로 알리면 즉시 재시도해 또 거부당한다)', async () => {
    const { service } = setup();
    await service.sendCode(EMAIL);
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS - 1));

    const result = await failure(service.sendCode(EMAIL));

    expect(result.body['retryAfterSeconds']).toBe(1);
  });
});

describe('AppSignupService.verifyCode', () => {
  it('맞는 인증번호면 증표와 수명(초)을 돌려준다', async () => {
    const ctx = setup();
    await ctx.service.sendCode(EMAIL);

    const result = await ctx.service.verifyCode(EMAIL, ctx.mails.codes[0]!.code);

    expect(result.verificationToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(result.expiresInSeconds).toBe(EMAIL_PROOF_TTL_MS / 1000);
  });

  it('증표에는 이 이메일과 가입 용도가 담긴다', async () => {
    const ctx = setup();
    const token = await verifiedToken(ctx);

    expect(await ctx.proofs.verify(token)).toMatchObject({
      ok: true,
      email: EMAIL,
      purpose: 'signup',
    });
  });

  describe('틀렸을 때', () => {
    it('400 EMAIL_CODE_INVALID와 남은 시도 횟수를 알려 준다', async () => {
      const ctx = setup({ random: () => 123456 });
      await ctx.service.sendCode(EMAIL);

      const result = await failure(ctx.service.verifyCode(EMAIL, '000000'));

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({
        code: APP_LOGIN_ERRORS.EMAIL_CODE_INVALID,
        attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - 1,
      });
    });

    it('틀릴 때마다 남은 횟수가 줄어든다', async () => {
      const ctx = setup({ random: () => 123456 });
      await ctx.service.sendCode(EMAIL);

      const left: unknown[] = [];
      for (let i = 0; i < 4; i++) {
        left.push((await failure(ctx.service.verifyCode(EMAIL, '000000'))).body['attemptsLeft']);
      }

      expect(left).toEqual([4, 3, 2, 1]);
    });

    it('받은 적 없는 이메일은 같은 코드(EMAIL_CODE_INVALID)이되 남은 횟수는 알려 주지 않는다', async () => {
      const { service } = setup();

      const result = await failure(service.verifyCode('nobody@example.com', '123456'));

      expect(result.status).toBe(400);
      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_CODE_INVALID);
      expect(result.body).not.toHaveProperty('attemptsLeft');
    });

    it('만료된 인증번호도 같은 응답이다 (만료와 틀림을 구분해서 알려 주지 않는다)', async () => {
      const ctx = setup({ random: () => 123456 });
      await ctx.service.sendCode(EMAIL);
      vi.setSystemTime(new Date(START.getTime() + 11 * 60 * 1000));

      const expired = await failure(ctx.service.verifyCode(EMAIL, '123456'));
      const unknown = await failure(ctx.service.verifyCode('nobody@example.com', '123456'));

      expect(expired).toEqual(unknown);
    });

    it('이미 쓴 인증번호도 같은 응답이다', async () => {
      const ctx = setup({ random: () => 123456 });
      await ctx.service.sendCode(EMAIL);
      await ctx.service.verifyCode(EMAIL, '123456');

      const reused = await failure(ctx.service.verifyCode(EMAIL, '123456'));

      expect(reused.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_CODE_INVALID);
      expect(reused.body).not.toHaveProperty('attemptsLeft');
    });
  });

  describe('시도 횟수를 모두 쓰면', () => {
    it('마지막 시도가 틀리면 429 EMAIL_CODE_LOCKED이다', async () => {
      const ctx = setup({ random: () => 123456 });
      await ctx.service.sendCode(EMAIL);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS - 1; i++) {
        await failure(ctx.service.verifyCode(EMAIL, '000000'));
      }

      const result = await failure(ctx.service.verifyCode(EMAIL, '000000'));

      expect(result.status).toBe(429);
      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_CODE_LOCKED);
    });

    it('잠긴 뒤에는 맞는 인증번호도 거부한다', async () => {
      const ctx = setup({ random: () => 123456 });
      await ctx.service.sendCode(EMAIL);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
        await failure(ctx.service.verifyCode(EMAIL, '000000'));
      }

      const result = await failure(ctx.service.verifyCode(EMAIL, '123456'));

      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_CODE_LOCKED);
    });

    it('새 인증번호를 받으면 다시 시도할 수 있다', async () => {
      const ctx = setup({ random: () => 123456 });
      await ctx.service.sendCode(EMAIL);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
        await failure(ctx.service.verifyCode(EMAIL, '000000'));
      }
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
      await ctx.service.sendCode(EMAIL);

      const result = await ctx.service.verifyCode(EMAIL, '123456');

      expect(result.verificationToken).toBeDefined();
    });
  });
});

describe('AppSignupService.signup', () => {
  describe('정상', () => {
    it('계정을 만든다 (이메일은 증표 안의 값이다)', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);

      await ctx.service.signup(token, PASSWORD);

      expect(ctx.users).toHaveLength(1);
      expect(ctx.users[0]).toMatchObject({ email: EMAIL, deletedAt: null });
    });

    it('아무것도 돌려주지 않는다 (토큰을 주지 않고, 로그인은 따로 한다)', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);

      expect(await ctx.service.signup(token, PASSWORD)).toBeUndefined();
    });

    it('비밀번호는 bcrypt 해시로만 저장하고 원문은 저장하지 않는다', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);

      await ctx.service.signup(token, PASSWORD);

      const row = ctx.users[0]!;
      expect(row.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
      expect(JSON.stringify(row)).not.toContain(PASSWORD);
      expect(await compare(PASSWORD, row.passwordHash!)).toBe(true);
    });

    it('같은 비밀번호도 계정마다 해시가 다르다 (솔트)', async () => {
      const ctx = setup();
      await ctx.service.signup(await verifiedToken(ctx, 'a@example.com'), PASSWORD);
      await ctx.service.signup(await verifiedToken(ctx, 'b@example.com'), PASSWORD);

      expect(ctx.users[0]!.passwordHash).not.toBe(ctx.users[1]!.passwordHash);
    });

    it('틀린 비밀번호는 해시와 맞지 않는다', async () => {
      const ctx = setup();
      await ctx.service.signup(await verifiedToken(ctx), PASSWORD);

      expect(await compare('WrongPassw0rd', ctx.users[0]!.passwordHash!)).toBe(false);
    });

    it('초기 닉네임을 만든다 (앱 닉네임 규칙: 한글 · 영문 · 숫자 2~10자)', async () => {
      const ctx = setup();
      await ctx.service.signup(await verifiedToken(ctx), PASSWORD);

      expect(ctx.users[0]!.nickname).toMatch(/^[가-힣A-Za-z0-9]{2,10}$/);
    });
  });

  describe('증표', () => {
    it('위조된 증표는 401 EMAIL_PROOF_INVALID이고 계정을 만들지 않는다', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      const forged = `${token.slice(0, -3)}abc`;

      const result = await failure(ctx.service.signup(forged, PASSWORD));

      expect(result.status).toBe(401);
      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_PROOF_INVALID);
      expect(ctx.users).toHaveLength(0);
    });

    it('엉뚱한 문자열도 같은 401이다', async () => {
      const { service, users } = setup();

      const result = await failure(service.signup('not-a-token', PASSWORD));

      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_PROOF_INVALID);
      expect(users).toHaveLength(0);
    });

    it('수명(10분)이 지난 증표는 401 EMAIL_PROOF_EXPIRED이고 계정을 만들지 않는다', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_PROOF_TTL_MS + 1_000));

      const result = await failure(ctx.service.signup(token, PASSWORD));

      expect(result.status).toBe(401);
      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_PROOF_EXPIRED);
      expect(ctx.users).toHaveLength(0);
    });

    it('같은 증표로 두 번 가입할 수 없다 (두 번째는 거부)', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      await ctx.service.signup(token, PASSWORD);

      const result = await failure(ctx.service.signup(token, PASSWORD));

      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_PROOF_INVALID);
      expect(ctx.users).toHaveLength(1);
    });

    it('같은 증표로 동시에 가입을 요청해도 계정은 하나만 만들어진다', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => ctx.service.signup(token, PASSWORD)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(ctx.users).toHaveLength(1);
    });

    it('인증번호를 다시 받으면 이전 증표로는 가입할 수 없다', async () => {
      const ctx = setup();
      const oldToken = await verifiedToken(ctx);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
      await ctx.service.sendCode(EMAIL);

      const result = await failure(ctx.service.signup(oldToken, PASSWORD));

      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_PROOF_INVALID);
      expect(ctx.users).toHaveLength(0);
    });

    it('다른 이메일로 인증한 증표로 가입해도 증표의 이메일로 가입된다 (요청으로 이메일을 바꿀 수 없다)', async () => {
      const ctx = setup();
      const tokenForB = await verifiedToken(ctx, 'b@example.com');

      await ctx.service.signup(tokenForB, PASSWORD);

      expect(ctx.users.map((u) => u.email)).toEqual(['b@example.com']);
    });
  });

  describe('이미 가입한 이메일', () => {
    it('409 EMAIL_TAKEN이다 (인증을 마친 본인에게만 알린다)', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      // 인증하는 사이에 같은 이메일로 가입이 끝난 상황
      ctx.users.push({
        _id: new Types.ObjectId(),
        email: EMAIL,
        passwordHash: 'h',
        nickname: 'n',
        deletedAt: null,
      });

      const result = await failure(ctx.service.signup(token, PASSWORD));

      expect(result.status).toBe(409);
      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_TAKEN);
      expect(ctx.users).toHaveLength(1);
    });

    it('소셜로 가입한 계정과 겹쳐도 409이고 합치지 않는다', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      ctx.users.push({
        _id: new Types.ObjectId(),
        email: EMAIL,
        passwordHash: null,
        nickname: '소셜',
        deletedAt: null,
      });

      const result = await failure(ctx.service.signup(token, PASSWORD));

      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_TAKEN);
      expect(ctx.users[0]!.passwordHash).toBeNull();
    });

    it('탈퇴한 계정이 이메일을 쥐고 있어도(유일 인덱스) 409로 안전하게 처리한다', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      ctx.users.push({
        _id: new Types.ObjectId(),
        email: EMAIL,
        passwordHash: 'h',
        nickname: 'n',
        deletedAt: new Date(),
      });

      const result = await failure(ctx.service.signup(token, PASSWORD));

      expect(result.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_TAKEN);
    });

    it('안내 문구가 가입 방법을 특정하지 않는다 (소셜 · 이메일 모두 안내)', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      ctx.users.push({
        _id: new Types.ObjectId(),
        email: EMAIL,
        passwordHash: null,
        nickname: 'n',
        deletedAt: null,
      });

      const result = await failure(ctx.service.signup(token, PASSWORD));

      expect(result.body['message']).toBe(
        '이미 가입한 이메일이에요. 처음 가입한 방법으로 로그인해 주세요',
      );
    });
  });

  describe('저장소 오류 (알려진 트레이드오프)', () => {
    it('계정 생성이 중복 키가 아닌 이유로 실패하면 그대로 던지고, 증표는 이미 소비된 상태다', async () => {
      const ctx = setup();
      const token = await verifiedToken(ctx);
      const broken = new AppSignupService(
        ctx.codes,
        ctx.proofs,
        {
          sendVerificationCode: () => Promise.resolve(),
          sendAlreadyRegistered: () => Promise.resolve(),
        },
        { create: () => Promise.reject(new Error('DB 쓰기 실패')) } as never,
        TEST_COST,
      );

      await expect(broken.signup(token, PASSWORD)).rejects.toThrow('DB 쓰기 실패');

      // 증표를 먼저 소비하는 설계라서 같은 증표로 다시 시도하면 거부된다: 사용자는 이메일 인증부터 다시 해야 한다
      const retry = await failure(ctx.service.signup(token, PASSWORD));
      expect(retry.body['code']).toBe(APP_LOGIN_ERRORS.EMAIL_PROOF_INVALID);
    });
  });
});

describe('비밀번호 해시 비용', () => {
  it('운영 기본값은 12이다 (비용이 낮으면 해시가 유출됐을 때 무차별 대입이 쉬워진다)', () => {
    expect(PASSWORD_HASH_COST).toBe(12);
  });

  it('비용을 주입하지 않으면 기본값(12)으로 해시한다', async () => {
    const ctx = setup();
    const token = await verifiedToken(ctx);
    const service = new AppSignupService(
      ctx.codes,
      ctx.proofs,
      {
        sendVerificationCode: () => Promise.resolve(),
        sendAlreadyRegistered: () => Promise.resolve(),
      },
      {
        create: (data: { passwordHash: string }) => {
          ctx.users.push({
            _id: new Types.ObjectId(),
            email: EMAIL,
            nickname: 'n',
            deletedAt: null,
            ...data,
          });
          return Promise.resolve();
        },
      } as never,
    );

    await service.signup(token, PASSWORD);

    expect(ctx.users[0]!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it('주입한 비용을 따른다 (시험에서 빠른 비용을 쓸 수 있다)', async () => {
    const ctx = setup();
    await ctx.service.signup(await verifiedToken(ctx), PASSWORD);

    expect(ctx.users[0]!.passwordHash).toMatch(/^\$2[aby]\$04\$/);
  });
});

describe('공통 보안', () => {
  it('어떤 오류 응답에도 비밀번호 · 증표 원문이 들어 있지 않다', async () => {
    const ctx = setup();
    const token = await verifiedToken(ctx);
    ctx.users.push({
      _id: new Types.ObjectId(),
      email: EMAIL,
      passwordHash: 'h',
      nickname: 'n',
      deletedAt: null,
    });

    const result = await failure(ctx.service.signup(token, PASSWORD));

    expect(JSON.stringify(result.body)).not.toContain(PASSWORD);
    expect(JSON.stringify(result.body)).not.toContain(token);
  });
});
