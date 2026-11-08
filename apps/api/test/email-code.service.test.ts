import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthCode, AuthCodeSchema } from '../src/modules/auth/schemas/auth-code.schema.js';
import { JWT_CONFIG as JWT_CONFIG_TOKEN } from '../src/modules/auth/token.service.js';
import {
  EMAIL_PROOF_TTL_MS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_MAX_SENDS_PER_WINDOW,
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  EMAIL_CODE_SEND_WINDOW_MS,
  EMAIL_CODE_RANDOM,
  EMAIL_CODE_TTL_MS,
  EmailCodeService,
} from '../src/modules/auth/app-login/email-code.service.js';
import { createFakeAuthCodes, type CodeRow } from './support/fake-auth-codes.js';

const JWT_CONFIG = {
  accessSecret: 'test-access-secret-0123456789abcdef',
  refreshSecret: 'test-refresh-secret-0123456789abcdef',
  accessTTL: '15m',
  refreshTTL: '14d',
} as never;

const EMAIL = 'student@example.com';
const START = new Date('2026-01-01T00:00:00Z');

function setup(options: { random?: (max: number) => number; accessSecret?: string } = {}) {
  const fake = createFakeAuthCodes();
  const config = options.accessSecret
    ? { ...(JWT_CONFIG as object), accessSecret: options.accessSecret }
    : JWT_CONFIG;
  const service = new EmailCodeService(fake.model as never, config as never, options.random);
  return { service, ...fake };
}

/** 발송에 성공한 결과에서 인증번호 원문을 꺼낸다. 실패하면 시험을 실패시킨다 */
async function issued(service: EmailCodeService, email = EMAIL): Promise<string> {
  const result = await service.issue(email, 'signup');
  if (!result.ok) throw new Error(`발송이 실패했다: ${result.reason}`);
  return result.code;
}

const wrongOf = (code: string) => (code === '000000' ? '000001' : '000000');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EmailCodeService.issue (인증번호 만들기)', () => {
  describe('인증번호', () => {
    it('6자리 숫자 문자열이다', async () => {
      const { service } = setup();

      expect(await issued(service)).toMatch(/^\d{6}$/);
    });

    it('앞자리가 0이어도 6자리를 유지한다 (숫자로 바꿔 쓰면 앞의 0이 사라진다)', async () => {
      const { service } = setup({ random: () => 42 });

      expect(await issued(service)).toBe('000042');
    });

    it('가능한 가장 큰 값도 6자리다', async () => {
      const { service } = setup({ random: (max) => max - 1 });

      expect(await issued(service)).toBe('999999');
    });

    it('난수는 0 이상 100만 미만에서 뽑는다 (6자리 전체 범위)', async () => {
      const seen: number[] = [];
      const { service } = setup({
        random: (max) => {
          seen.push(max);
          return 0;
        },
      });

      await issued(service);

      expect(seen).toEqual([1_000_000]);
    });

    it('매번 다른 값이 나온다 (예측할 수 없다)', async () => {
      const { service } = setup();
      const codes = new Set<string>();
      for (let i = 0; i < 50; i++) {
        vi.setSystemTime(new Date(START.getTime() + i * 2 * EMAIL_CODE_SEND_WINDOW_MS));
        codes.add(await issued(service));
      }

      expect(codes.size).toBeGreaterThan(40);
    });
  });

  describe('저장', () => {
    it('원문이 아니라 HMAC 해시만 저장한다', async () => {
      const { service, rows } = setup();

      const code = await issued(service);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows[0])).not.toContain(code);
    });

    it('같은 인증번호라도 이메일이 다르면 해시가 다르다 (남의 해시를 내 계정에 옮겨도 통하지 않는다)', async () => {
      const { service, rows } = setup({ random: () => 123456 });

      await service.issue('a@example.com', 'signup');
      await service.issue('b@example.com', 'signup');

      expect(rows[0]!.codeHash).not.toBe(rows[1]!.codeHash);
    });

    it('남의 해시를 내 문서에 옮겨 놓아도 내 이메일로는 통과하지 않는다', async () => {
      const { service, rows } = setup({ random: () => 123456 });
      await service.issue('a@example.com', 'signup');
      await service.issue('b@example.com', 'signup');
      rows[1]!.codeHash = rows[0]!.codeHash; // 공격자가 DB에서 a의 해시를 b에 복사했다고 가정

      expect((await service.verify('b@example.com', 'signup', '123456')).ok).toBe(false);
    });

    it('서버 비밀값이 다르면 같은 인증번호도 다른 해시가 된다 (DB만 유출돼도 역산할 수 없다)', async () => {
      const a = setup({ random: () => 123456 });
      const b = setup({
        random: () => 123456,
        accessSecret: 'another-access-secret-0123456789abc',
      });

      await a.service.issue(EMAIL, 'signup');
      await b.service.issue(EMAIL, 'signup');

      expect(a.rows[0]!.codeHash).not.toBe(b.rows[0]!.codeHash);
    });

    it('비밀값이 같으면 같은 입력에서 같은 해시가 나온다 (확인이 가능해야 한다)', async () => {
      const a = setup({ random: () => 123456 });
      const b = setup({ random: () => 123456 });

      await a.service.issue(EMAIL, 'signup');
      await b.service.issue(EMAIL, 'signup');

      expect(a.rows[0]!.codeHash).toBe(b.rows[0]!.codeHash);
    });

    it('다른 비밀값으로 만든 서비스는 해시를 확인하지 못한다', async () => {
      const a = setup({ random: () => 123456 });
      await a.service.issue(EMAIL, 'signup');
      const other = new EmailCodeService(
        a.model as never,
        { accessSecret: 'another-access-secret-0123456789abc' } as never,
      );

      expect((await other.verify(EMAIL, 'signup', '123456')).ok).toBe(false);
    });

    it('만료는 10분 뒤이고, 처음에는 시도 0회 · 쓰지 않음이다', async () => {
      const { service, rows } = setup();

      await issued(service);

      expect(rows[0]).toMatchObject({
        email: EMAIL,
        purpose: 'signup',
        attempts: 0,
        usedAt: null,
        sendCount: 1,
        lastSentAt: START,
        expiresAt: new Date(START.getTime() + EMAIL_CODE_TTL_MS),
        windowEndsAt: new Date(START.getTime() + EMAIL_CODE_SEND_WINDOW_MS),
        retainUntil: new Date(START.getTime() + EMAIL_CODE_SEND_WINDOW_MS),
      });
      expect(rows[0]!.issueId).toEqual(expect.any(String));
      expect(EMAIL_CODE_TTL_MS).toBe(10 * 60 * 1000);
    });

    it('이메일이 다르면 서로 영향을 주지 않는다', async () => {
      const { service, rows } = setup();

      await issued(service, 'a@example.com');
      await issued(service, 'b@example.com');

      expect(rows).toHaveLength(2);
    });
  });

  describe('다시 보내기', () => {
    it('간격(60초) 안에 다시 보내면 거부하고 남은 시간을 알려 준다', async () => {
      const { service } = setup();
      await issued(service);
      vi.setSystemTime(new Date(START.getTime() + 20_000));

      const result = await service.issue(EMAIL, 'signup');

      expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfterMs: 40_000 });
    });

    it('간격이 정확히 지난 순간부터 다시 보낼 수 있다 (경계)', async () => {
      const { service } = setup();
      await issued(service);

      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS - 1));
      expect((await service.issue(EMAIL, 'signup')).ok).toBe(false);

      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
      expect((await service.issue(EMAIL, 'signup')).ok).toBe(true);
    });

    it('다시 보내면 이전 인증번호는 무효가 되고 새 인증번호만 통한다', async () => {
      const { service } = setup();
      const first = await issued(service);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
      const second = await issued(service);

      if (first !== second) {
        expect((await service.verify(EMAIL, 'signup', first)).ok).toBe(false);
      }
      expect((await service.verify(EMAIL, 'signup', second)).ok).toBe(true);
    });

    it('다시 보내면 틀린 횟수와 쓴 표시가 초기화된다', async () => {
      const { service, rows } = setup();
      const first = await issued(service);
      await service.verify(EMAIL, 'signup', wrongOf(first));
      await service.verify(EMAIL, 'signup', first);
      expect(rows[0]).toMatchObject({ usedAt: expect.any(Date) });
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));

      await issued(service);

      expect(rows[0]).toMatchObject({ attempts: 0, usedAt: null });
    });

    it('다시 보낼 때마다 만료 시각이 새로 정해진다', async () => {
      const { service, rows } = setup();
      await issued(service);
      const later = new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS);
      vi.setSystemTime(later);

      await issued(service);

      expect(rows[0]!.expiresAt).toEqual(new Date(later.getTime() + EMAIL_CODE_TTL_MS));
    });
  });

  describe('구간당 횟수 제한', () => {
    async function sendMax(service: EmailCodeService) {
      for (let i = 0; i < EMAIL_CODE_MAX_SENDS_PER_WINDOW; i++) {
        vi.setSystemTime(new Date(START.getTime() + i * EMAIL_CODE_RESEND_COOLDOWN_MS));
        await issued(service);
      }
    }

    it('제한 구간은 1시간, 한도는 5번이다 (상수 자체를 못박는다)', () => {
      expect(EMAIL_CODE_SEND_WINDOW_MS).toBe(60 * 60 * 1000);
      expect(EMAIL_CODE_MAX_SENDS_PER_WINDOW).toBe(5);
      expect(EMAIL_CODE_RESEND_COOLDOWN_MS).toBe(60 * 1000);
      expect(EMAIL_CODE_MAX_ATTEMPTS).toBe(5);
    });

    it('구간 안에서 5번까지 보낼 수 있다', async () => {
      const { service, rows } = setup();

      await sendMax(service);

      expect(rows[0]!.sendCount).toBe(5);
    });

    it('6번째는 간격을 지켰어도 거부하고, 구간이 끝날 때까지 남은 시간을 알려 준다', async () => {
      const { service } = setup();
      await sendMax(service);
      const at = new Date(START.getTime() + 5 * EMAIL_CODE_RESEND_COOLDOWN_MS);
      vi.setSystemTime(at);

      const result = await service.issue(EMAIL, 'signup');

      expect(result).toEqual({
        ok: false,
        reason: 'limit',
        retryAfterMs: START.getTime() + EMAIL_CODE_SEND_WINDOW_MS - at.getTime(),
      });
    });

    it('구간이 끝나면 횟수를 처음부터 센다 (경계)', async () => {
      const { service, rows } = setup();
      await sendMax(service);

      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_SEND_WINDOW_MS - 1));
      expect((await service.issue(EMAIL, 'signup')).ok).toBe(false);

      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_SEND_WINDOW_MS));
      expect((await service.issue(EMAIL, 'signup')).ok).toBe(true);
      expect(rows[0]!.sendCount).toBe(1);
    });

    it('한도에 걸린 요청은 기존 인증번호를 건드리지 않는다', async () => {
      const { service, rows } = setup();
      await sendMax(service);
      const before = { ...rows[0]! };
      vi.setSystemTime(new Date(START.getTime() + 5 * EMAIL_CODE_RESEND_COOLDOWN_MS));

      await service.issue(EMAIL, 'signup');

      expect(rows[0]).toEqual(before);
    });

    it('간격에 걸린 요청도 기존 인증번호를 건드리지 않는다 (공격자가 연타해도 사용자의 인증번호가 무효가 되지 않는다)', async () => {
      const { service, rows } = setup();
      const code = await issued(service);
      vi.setSystemTime(new Date(START.getTime() + 1_000));

      await service.issue(EMAIL, 'signup');

      expect((await service.verify(EMAIL, 'signup', code)).ok).toBe(true);
      expect(rows[0]!.sendCount).toBe(1);
    });
  });

  describe('동시 요청', () => {
    it('같은 이메일로 동시에 50번 요청해도 한 번만 발송된다', async () => {
      const { service, rows } = setup();

      const results = await Promise.all(
        Array.from({ length: 50 }, () => service.issue(EMAIL, 'signup')),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.reason === 'cooldown')).toHaveLength(49);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sendCount).toBe(1);
    });

    it('이미 문서가 있는 상태에서 간격이 지난 뒤 동시에 요청해도 한 번만 발송된다', async () => {
      const { service, rows } = setup();
      await issued(service);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));

      const results = await Promise.all(
        Array.from({ length: 50 }, () => service.issue(EMAIL, 'signup')),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(rows[0]!.sendCount).toBe(2);
    });
  });
});

describe('EmailCodeService.verify 성공 시 기록 보관', () => {
  it('인증 성공 후 증표 수명(10분) 동안 기록이 지워지지 않도록 보관 기한을 늘린다', async () => {
    const { service, rows } = setup();
    const code = await issued(service);
    // 제한 구간이 끝나기 직전에 인증하는 상황: 구간 끝까지 1분 남음
    const at = new Date(START.getTime() + EMAIL_CODE_SEND_WINDOW_MS - 60_000);
    vi.setSystemTime(at);
    rows[0]!.expiresAt = new Date(at.getTime() + 60_000); // 인증번호 자체는 아직 유효하게 맞춘다

    await service.verify(EMAIL, 'signup', code);

    expect(rows[0]!.retainUntil).toEqual(new Date(at.getTime() + EMAIL_PROOF_TTL_MS));
  });

  it('보관 기한이 이미 충분히 길면 줄이지 않는다 ($max: 더 늦은 쪽만 반영)', async () => {
    const { service, rows } = setup();
    const code = await issued(service);
    const originalEnd = rows[0]!.retainUntil;

    await service.verify(EMAIL, 'signup', code);

    expect(rows[0]!.retainUntil).toEqual(originalEnd);
  });

  it('증표 수명은 10분이다 (상수 자체를 못박는다)', () => {
    expect(EMAIL_PROOF_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('틀린 입력에서는 보관 기한을 늘리지 않는다 (실패로 기록을 오래 붙잡을 수 없다)', async () => {
    const { service, rows } = setup();
    const code = await issued(service);
    const originalEnd = rows[0]!.retainUntil;
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_SEND_WINDOW_MS - 60_000));
    rows[0]!.expiresAt = new Date(START.getTime() + EMAIL_CODE_SEND_WINDOW_MS);

    await service.verify(EMAIL, 'signup', wrongOf(code));

    expect(rows[0]!.retainUntil).toEqual(originalEnd);
  });
});

describe('EmailCodeService.consume (증표 소비)', () => {
  async function verified() {
    const ctx = setup();
    const code = await issued(ctx.service);
    const result = await ctx.service.verify(EMAIL, 'signup', code);
    if (!result.ok) throw new Error('인증 실패');
    return { ...ctx, code, verifiedAt: result.verifiedAt };
  }

  it('인증한 시각과 일치하면 성공하고 소비 시각을 기록한다', async () => {
    const { service, rows, verifiedAt } = await verified();

    expect(await service.consume(EMAIL, 'signup', verifiedAt)).toBe(true);
    expect(rows[0]!.consumedAt).toEqual(START);
  });

  it('한 인증은 한 번만 소비할 수 있다', async () => {
    const { service, verifiedAt } = await verified();
    await service.consume(EMAIL, 'signup', verifiedAt);

    expect(await service.consume(EMAIL, 'signup', verifiedAt)).toBe(false);
  });

  it('같은 증표로 동시에 소비해도 한 번만 성공한다', async () => {
    const { service, verifiedAt } = await verified();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.consume(EMAIL, 'signup', verifiedAt)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('인증 시각이 다르면 소비할 수 없다 (엉뚱한 증표)', async () => {
    const { service } = await verified();

    expect(await service.consume(EMAIL, 'signup', new Date(START.getTime() + 1))).toBe(false);
  });

  it('인증번호를 다시 받으면 이전 증표로는 소비할 수 없다 (새 발송이 이전 인증을 무효로 만든다)', async () => {
    const { service, verifiedAt } = await verified();
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
    await issued(service);

    expect(await service.consume(EMAIL, 'signup', verifiedAt)).toBe(false);
  });

  it('다시 받은 인증번호로 새로 인증하면 새 증표로 소비할 수 있고, 이전 증표는 여전히 안 된다', async () => {
    const { service, verifiedAt: first } = await verified();
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
    const code = await issued(service);
    const second = await service.verify(EMAIL, 'signup', code);
    if (!second.ok) throw new Error('인증 실패');

    expect(await service.consume(EMAIL, 'signup', first)).toBe(false);
    expect(await service.consume(EMAIL, 'signup', second.verifiedAt)).toBe(true);
  });

  it('소비한 뒤 인증번호를 다시 받으면 소비 표시가 초기화된다', async () => {
    const { service, rows, verifiedAt } = await verified();
    await service.consume(EMAIL, 'signup', verifiedAt);
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));

    await issued(service);

    expect(rows[0]!.consumedAt).toBeNull();
  });

  it('다른 이메일의 인증으로는 소비할 수 없다', async () => {
    const { service, verifiedAt } = await verified();

    expect(await service.consume('other@example.com', 'signup', verifiedAt)).toBe(false);
  });

  it('인증하지 않은(쓰지 않은) 인증번호는 소비할 수 없다', async () => {
    const { service } = setup();
    await issued(service);

    expect(await service.consume(EMAIL, 'signup', START)).toBe(false);
  });
});

describe('발송 중 저장소 오류', () => {
  it('새 문서를 만들다 중복 키가 아닌 오류가 나면 그대로 던진다 (DB 장애를 "간격 제한"으로 숨기지 않는다)', async () => {
    const { service, model } = (() => {
      const f = createFakeAuthCodes();
      const svc = new EmailCodeService(f.model as never, JWT_CONFIG);
      return { service: svc, model: f.model };
    })();
    model.create = () => Promise.reject(new Error('DB 연결 끊김'));

    await expect(service.issue(EMAIL, 'signup')).rejects.toThrow('DB 연결 끊김');
  });

  it('중복 키 오류(동시에 다른 요청이 먼저 만듦)는 간격 제한으로 알린다', async () => {
    const f = createFakeAuthCodes();
    const svc = new EmailCodeService(f.model as never, JWT_CONFIG);
    f.model.create = () => Promise.reject(Object.assign(new Error('dup'), { code: 11000 }));

    expect(await svc.issue(EMAIL, 'signup')).toEqual({
      ok: false,
      reason: 'cooldown',
      retryAfterMs: EMAIL_CODE_RESEND_COOLDOWN_MS,
    });
  });

  it('조회 중 저장소 오류도 그대로 던진다', async () => {
    const f = createFakeAuthCodes();
    const svc = new EmailCodeService(f.model as never, JWT_CONFIG);
    f.model.findOne = () => ({ lean: () => Promise.reject(new Error('DB 읽기 실패')) });

    await expect(svc.issue(EMAIL, 'signup')).rejects.toThrow('DB 읽기 실패');
  });
});

describe('EmailCodeService.verify (인증번호 확인)', () => {
  describe('성공', () => {
    it('맞는 인증번호면 성공한다', async () => {
      const { service } = setup();
      const code = await issued(service);

      expect(await service.verify(EMAIL, 'signup', code)).toEqual({ ok: true, verifiedAt: START });
    });

    it('성공 결과의 verifiedAt은 인증에 성공한 시각이다 (증표가 이 인증을 특정하는 데 쓴다)', async () => {
      const { service, rows } = setup();
      const code = await issued(service);
      const at = new Date(START.getTime() + 30_000);
      vi.setSystemTime(at);

      const result = await service.verify(EMAIL, 'signup', code);

      expect(result).toEqual({ ok: true, verifiedAt: at });
      expect(rows[0]!.usedAt).toEqual(at);
    });

    it('성공하면 쓴 것으로 표시한다', async () => {
      const { service, rows } = setup();
      const code = await issued(service);

      await service.verify(EMAIL, 'signup', code);

      expect(rows[0]!.usedAt).toEqual(START);
    });

    it('성공한 인증번호는 다시 쓸 수 없다 (한 번만)', async () => {
      const { service } = setup();
      const code = await issued(service);
      await service.verify(EMAIL, 'signup', code);

      expect(await service.verify(EMAIL, 'signup', code)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('쓴 인증번호를 다시 확인해도 시도 횟수가 늘지 않는다 (이미 끝난 인증번호는 시도 자격이 없다)', async () => {
      const { service, rows } = setup();
      const code = await issued(service);
      await service.verify(EMAIL, 'signup', code);
      const attemptsAfterSuccess = rows[0]!.attempts;

      await service.verify(EMAIL, 'signup', code);
      await service.verify(EMAIL, 'signup', wrongOf(code));

      expect(rows[0]!.attempts).toBe(attemptsAfterSuccess);
    });

    it('쓴 인증번호는 시도 한도까지 채워도 잠김이 아니라 invalid로 알린다 (끝난 인증번호의 상태를 구분해 알리지 않는다)', async () => {
      const { service, rows } = setup();
      const code = await issued(service);
      await service.verify(EMAIL, 'signup', code);
      rows[0]!.attempts = EMAIL_CODE_MAX_ATTEMPTS; // 쓴 뒤 시도 횟수가 한도에 닿은 상태를 만든다

      expect(await service.verify(EMAIL, 'signup', code)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('만료 직전(경계)까지는 성공하고, 만료 시각부터는 실패한다', async () => {
      const { service } = setup();
      const code = await issued(service);

      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_TTL_MS - 1));
      expect((await service.verify(EMAIL, 'signup', code)).ok).toBe(true);
    });

    it('만료 시각이 되면 맞는 인증번호도 실패한다', async () => {
      const { service } = setup();
      const code = await issued(service);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_TTL_MS));

      expect(await service.verify(EMAIL, 'signup', code)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('앞자리가 0인 인증번호도 문자열 그대로 비교한다', async () => {
      const { service } = setup({ random: () => 42 });
      await service.issue(EMAIL, 'signup');

      expect((await service.verify(EMAIL, 'signup', '000042')).ok).toBe(true);
    });

    it('앞의 0을 뺀 값("42")은 통과하지 않는다', async () => {
      const { service } = setup({ random: () => 42 });
      await service.issue(EMAIL, 'signup');

      expect((await service.verify(EMAIL, 'signup', '42')).ok).toBe(false);
    });
  });

  describe('실패', () => {
    it('틀린 인증번호면 남은 시도 횟수를 알려 준다', async () => {
      const { service } = setup();
      const code = await issued(service);

      expect(await service.verify(EMAIL, 'signup', wrongOf(code))).toEqual({
        ok: false,
        reason: 'wrong',
        attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - 1,
      });
    });

    it('틀릴 때마다 남은 횟수가 줄어든다', async () => {
      const { service } = setup();
      const code = await issued(service);

      const left: number[] = [];
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS - 1; i++) {
        const r = await service.verify(EMAIL, 'signup', wrongOf(code));
        if (!r.ok && r.reason === 'wrong') left.push(r.attemptsLeft);
      }

      expect(left).toEqual([4, 3, 2, 1]);
    });

    it('마지막(5번째) 시도가 틀리면 바로 잠긴다고 알린다', async () => {
      const { service } = setup();
      const code = await issued(service);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS - 1; i++) {
        await service.verify(EMAIL, 'signup', wrongOf(code));
      }

      expect(await service.verify(EMAIL, 'signup', wrongOf(code))).toEqual({
        ok: false,
        reason: 'locked',
      });
    });

    it('5번 틀린 뒤에는 맞는 인증번호를 넣어도 실패한다 (잠김)', async () => {
      const { service } = setup();
      const code = await issued(service);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
        await service.verify(EMAIL, 'signup', wrongOf(code));
      }

      expect(await service.verify(EMAIL, 'signup', code)).toEqual({ ok: false, reason: 'locked' });
    });

    it('4번 틀리고 5번째에 맞으면 성공한다 (한도 안)', async () => {
      const { service } = setup();
      const code = await issued(service);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS - 1; i++) {
        await service.verify(EMAIL, 'signup', wrongOf(code));
      }

      expect((await service.verify(EMAIL, 'signup', code)).ok).toBe(true);
    });

    it('잠긴 뒤 새 인증번호를 받으면 다시 시도할 수 있다', async () => {
      const { service } = setup();
      const code = await issued(service);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
        await service.verify(EMAIL, 'signup', wrongOf(code));
      }
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));

      const fresh = await issued(service);

      expect((await service.verify(EMAIL, 'signup', fresh)).ok).toBe(true);
    });

    it('받은 적 없는 이메일이면 invalid이다 (없음 · 만료 · 이미 씀을 구분해서 알려 주지 않는다)', async () => {
      const { service } = setup();

      expect(await service.verify('nobody@example.com', 'signup', '123456')).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('만료된 인증번호는 시도 횟수를 다 썼어도 locked가 아니라 invalid이다', async () => {
      const { service } = setup();
      const code = await issued(service);
      for (let i = 0; i < EMAIL_CODE_MAX_ATTEMPTS; i++) {
        await service.verify(EMAIL, 'signup', wrongOf(code));
      }
      vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_TTL_MS));

      expect(await service.verify(EMAIL, 'signup', code)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('다른 이메일의 인증번호로는 통하지 않는다', async () => {
      // 두 이메일에 서로 다른 인증번호를 정해 둔다
      let n = 0;
      const { service } = setup({ random: () => [111111, 222222][n++ % 2]! });
      await service.issue('a@example.com', 'signup');
      await service.issue('b@example.com', 'signup');

      const result = await service.verify('b@example.com', 'signup', '111111');

      expect(result).toEqual({ ok: false, reason: 'wrong', attemptsLeft: 4 });
    });
  });

  describe('시도 횟수 제한은 동시 요청에도 지켜진다', () => {
    it('틀린 추측을 동시에 100번 보내도 실제 비교는 5번까지만 일어난다', async () => {
      const { service, rows } = setup();
      const code = await issued(service);

      const results = await Promise.all(
        Array.from({ length: 100 }, () => service.verify(EMAIL, 'signup', wrongOf(code))),
      );

      expect(rows[0]!.attempts).toBe(EMAIL_CODE_MAX_ATTEMPTS);
      const compared = results.filter(
        (r) => !r.ok && (r.reason === 'wrong' || r.reason === 'locked'),
      );
      // 비교까지 간 것은 5개, 나머지 95개는 자격 없이 잠김으로 거절된다
      expect(results.filter((r) => !r.ok && r.reason === 'wrong').length).toBeLessThanOrEqual(
        EMAIL_CODE_MAX_ATTEMPTS - 1,
      );
      expect(compared).toHaveLength(100);
    });

    it('동시 추측 중에 맞는 값이 섞여도 한도를 넘긴 요청은 성공하지 못한다', async () => {
      const { service } = setup();
      const code = await issued(service);
      // 틀린 추측 5개가 먼저 한도를 채우고, 그 뒤에 맞는 값이 도착하는 최악의 순서
      await Promise.all(
        Array.from({ length: EMAIL_CODE_MAX_ATTEMPTS }, () =>
          service.verify(EMAIL, 'signup', wrongOf(code)),
        ),
      );

      expect((await service.verify(EMAIL, 'signup', code)).ok).toBe(false);
    });

    it('같은 인증번호로 동시에 여러 번 확인해도 성공은 한 번뿐이다', async () => {
      const { service } = setup();
      const code = await issued(service);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.verify(EMAIL, 'signup', code)),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });
  });
});

describe('보안', () => {
  it('오류 결과에 인증번호나 해시가 들어 있지 않다', async () => {
    const { service } = setup();
    const code = await issued(service);

    const results = [
      await service.verify(EMAIL, 'signup', wrongOf(code)),
      await service.verify('x@example.com', 'signup', code),
      await service.issue(EMAIL, 'signup'),
    ];

    expect(JSON.stringify(results)).not.toContain(code);
    expect(JSON.stringify(results)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('검증과 재발급이 교차 실행될 때', () => {
  type Model = ReturnType<typeof setup>['model'];

  /** verify가 번호를 비교한 직후, "쓴 것으로 표시"하기 직전에 멈춰 세운다(그 틈에 다른 요청을 끼워 넣기 위함) */
  function pauseBeforeMarkUsed(model: Model) {
    const original = model.updateOne;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    model.updateOne = async (filter, update) => {
      if ('_id' in filter) {
        reached();
        await gate;
      }
      return original(filter, update);
    };
    return { atGate, release };
  }

  it('확인하는 동안 새 번호가 발급되면, 이전 번호의 확인은 실패하고 새 번호는 쓰지 않은 채로 남는다', async () => {
    const { service, rows, model } = setup();
    const oldCode = await issued(service);
    const pause = pauseBeforeMarkUsed(model);

    const pending = service.verify(EMAIL, 'signup', oldCode);
    await pause.atGate; // 이전 번호가 맞다고 비교까지 끝난 상태
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
    const newCode = await issued(service); // 이 사이에 새 번호가 발급된다
    pause.release();

    expect(await pending).toEqual({ ok: false, reason: 'invalid' });
    expect(rows[0]).toMatchObject({ usedAt: null, attempts: 0 });
    // 새 번호는 사용자가 받은 그대로 여전히 쓸 수 있다
    expect((await service.verify(EMAIL, 'signup', newCode)).ok).toBe(true);
  });

  it('새 번호가 우연히 이전 번호와 같은 값이어도 이전 발급의 확인은 인정하지 않는다 (번호가 아니라 발급 단위로 지킨다)', async () => {
    const { service, rows, model } = setup({ random: () => 424242 });
    const oldCode = await issued(service);
    const pause = pauseBeforeMarkUsed(model);

    const pending = service.verify(EMAIL, 'signup', oldCode);
    await pause.atGate;
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
    expect(await issued(service)).toBe(oldCode);
    pause.release();

    expect(await pending).toEqual({ ok: false, reason: 'invalid' });
    expect(rows[0]!.usedAt).toBeNull();
  });

  it('끼어든 재발급은 보관 기한도 이전 확인으로 늘어나지 않는다', async () => {
    const { service, rows, model } = setup();
    const oldCode = await issued(service);
    const pause = pauseBeforeMarkUsed(model);

    const pending = service.verify(EMAIL, 'signup', oldCode);
    await pause.atGate;
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));
    await issued(service);
    const retainBefore = rows[0]!.retainUntil;
    pause.release();
    await pending;

    expect(rows[0]!.retainUntil).toEqual(retainBefore);
  });

  it('발급할 때마다 발급 식별자가 바뀐다', async () => {
    const { service, rows } = setup();
    await issued(service);
    const first = rows[0]!.issueId;
    vi.setSystemTime(new Date(START.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS));

    await issued(service);

    expect(rows[0]!.issueId).not.toBe(first);
  });

  it('간격에 걸려 거부된 요청은 발급 식별자를 바꾸지 않는다 (진행 중인 확인이 깨지지 않는다)', async () => {
    const { service, rows } = setup();
    await issued(service);
    const first = rows[0]!.issueId;

    expect((await service.issue(EMAIL, 'signup')).ok).toBe(false);

    expect(rows[0]!.issueId).toBe(first);
  });
});

describe('보관 기한(TTL)과 발송 제한 구간', () => {
  const MIN = 60_000;
  const at = (ms: number) => new Date(START.getTime() + ms);

  /** 스키마에 실제로 걸린 TTL 인덱스의 필드(MongoDB가 이 필드 시각이 지난 문서를 지운다) */
  const ttlField = (() => {
    const [fields] = AuthCodeSchema.indexes().find(
      ([, options]) => options?.expireAfterSeconds !== undefined,
    )!;
    return Object.keys(fields)[0] as 'retainUntil' | 'windowEndsAt' | 'expiresAt';
  })();

  /** MongoDB의 TTL 삭제를 흉내 낸다: TTL 필드 시각이 지난 문서를 지운다 */
  function sweep(rows: CodeRow[], now: Date) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]![ttlField].getTime() <= now.getTime()) rows.splice(i, 1);
    }
  }

  it('TTL 인덱스는 발송 제한 구간(windowEndsAt)이 아니라 보관 기한(retainUntil)에 걸려 있다', () => {
    expect(ttlField).toBe('retainUntil');
  });

  it('구간 말미(59분)에 다시 받은 번호는 유효한 69분까지 지워지지 않아 인증에 성공한다', async () => {
    const { service, rows } = setup();
    await issued(service);
    vi.setSystemTime(at(59 * MIN));
    const code = await issued(service); // 최초 발송 59분 뒤 재발급 → 69분까지 유효

    for (const minute of [60, 64, 68]) {
      vi.setSystemTime(at(minute * MIN));
      sweep(rows, at(minute * MIN));
      expect(rows).toHaveLength(1);
    }
    vi.setSystemTime(at(68 * MIN));
    expect((await service.verify(EMAIL, 'signup', code)).ok).toBe(true);
  });

  it('번호가 만료되고 제한 구간도 끝나면 문서를 지울 수 있다 (영원히 남기지 않는다)', async () => {
    const { service, rows } = setup();
    await issued(service);
    vi.setSystemTime(at(59 * MIN));
    await issued(service);

    sweep(rows, at(69 * MIN));

    expect(rows).toHaveLength(0);
  });

  it('제한 구간이 끝나기 전에는 번호가 만료됐어도 지우지 않는다 (발송 횟수 기록을 유지한다)', async () => {
    const { service, rows } = setup();
    await issued(service);

    sweep(rows, at(30 * MIN)); // 번호는 10분에 이미 만료됐다

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sendCount).toBe(1);
  });

  it('구간 끝(60분)에 문서가 지워지지 않고, 구간 안에서 보낸 한도 기록이 그대로 남는다', async () => {
    const { service, rows } = setup();
    for (let i = 0; i < EMAIL_CODE_MAX_SENDS_PER_WINDOW; i++) {
      vi.setSystemTime(at(i * MIN));
      await issued(service);
    }

    sweep(rows, at(60 * MIN - 1));

    expect(rows).toHaveLength(1);
    vi.setSystemTime(at(60 * MIN - 1));
    expect(await service.issue(EMAIL, 'signup')).toMatchObject({ ok: false, reason: 'limit' });
  });

  it('인증에 성공하면 증표가 유효한 10분 동안은 문서가 지워지지 않아 가입을 끝낼 수 있다', async () => {
    const { service, rows } = setup();
    await issued(service);
    vi.setSystemTime(at(58 * MIN + 30_000));
    const code = await issued(service);
    vi.setSystemTime(at(59 * MIN));
    const verified = await service.verify(EMAIL, 'signup', code);
    if (!verified.ok) throw new Error('인증에 실패했다');

    sweep(rows, at(68 * MIN + 59_000)); // 인증 + 10분 직전

    expect(rows).toHaveLength(1);
    vi.setSystemTime(at(68 * MIN + 59_000));
    expect(await service.consume(EMAIL, 'signup', verified.verifiedAt)).toBe(true);
  });

  it('보관 기한은 번호 만료 · 제한 구간 끝 중 늦은 쪽보다 앞서지 않는다 (재발송 · 새 구간 모두)', async () => {
    const { service, rows } = setup();
    await issued(service);

    vi.setSystemTime(at(59 * MIN));
    await issued(service); // 같은 구간 안 재발송
    expect(rows[0]!.retainUntil.getTime()).toBe(
      Math.max(rows[0]!.windowEndsAt.getTime(), rows[0]!.expiresAt.getTime()),
    );

    vi.setSystemTime(at(61 * MIN));
    await issued(service); // 구간이 끝난 뒤 새 구간
    expect(rows[0]!.retainUntil.getTime()).toBe(
      Math.max(rows[0]!.windowEndsAt.getTime(), rows[0]!.expiresAt.getTime()),
    );
    expect(rows[0]!.windowEndsAt).toEqual(at(61 * MIN + EMAIL_CODE_SEND_WINDOW_MS));
  });
});

describe('제한 구간 경계의 재발송 간격', () => {
  const MIN = 60_000;
  const at = (ms: number) => new Date(START.getTime() + ms);

  it('구간이 끝나는 순간이어도 마지막 발송 뒤 60초가 지나지 않았으면 거부한다', async () => {
    const { service, rows } = setup();
    await issued(service);
    vi.setSystemTime(at(59 * MIN + 30_000));
    await issued(service); // 구간 끝(60분)까지 30초 남은 때 발송
    const before = { ...rows[0]! };

    vi.setSystemTime(at(60 * MIN)); // 구간은 끝났지만 마지막 발송 뒤 30초뿐
    const result = await service.issue(EMAIL, 'signup');

    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfterMs: 30_000 });
    expect(rows[0]).toEqual(before); // 거부된 요청은 아무것도 바꾸지 않는다
  });

  it('간격이 지나면(60초 뒤) 새 구간으로 다시 센다', async () => {
    const { service, rows } = setup();
    await issued(service);
    vi.setSystemTime(at(59 * MIN + 30_000));
    await issued(service);

    vi.setSystemTime(at(60 * MIN + 29_999));
    expect(await service.issue(EMAIL, 'signup')).toMatchObject({ ok: false, reason: 'cooldown' });

    vi.setSystemTime(at(60 * MIN + 30_000)); // 정확히 60초 (경계)
    expect((await service.issue(EMAIL, 'signup')).ok).toBe(true);
    expect(rows[0]!.sendCount).toBe(1);
  });

  it('발송 한도를 다 쓴 직후 구간이 끝나도 간격이 남았으면 한도(limit 0ms)가 아니라 간격으로 알린다', async () => {
    const { service } = setup();
    for (const minute of [0, 1, 2, 3]) {
      vi.setSystemTime(at(minute * MIN));
      await issued(service);
    }
    vi.setSystemTime(at(59 * MIN + 30_000));
    await issued(service); // 5번째: 한도를 다 썼다

    vi.setSystemTime(at(60 * MIN));
    const result = await service.issue(EMAIL, 'signup');

    expect(result).toEqual({ ok: false, reason: 'cooldown', retryAfterMs: 30_000 });
  });

  it('구간 안에서 한도를 다 쓴 경우는 구간이 끝날 때까지 남은 시간을 알린다 (기존 동작 유지)', async () => {
    const { service } = setup();
    for (let i = 0; i < EMAIL_CODE_MAX_SENDS_PER_WINDOW; i++) {
      vi.setSystemTime(at(i * MIN));
      await issued(service);
    }

    vi.setSystemTime(at(10 * MIN));
    expect(await service.issue(EMAIL, 'signup')).toEqual({
      ok: false,
      reason: 'limit',
      retryAfterMs: 50 * MIN,
    });
  });
});

describe('Nest 의존성 주입', () => {
  // `new`로 직접 만드는 시험은 생성자 인자를 Nest가 어떻게 해석하는지 보지 못한다.
  // 난수 생성기 인자가 주입 대상으로 잘못 해석되어 서버가 시작하지 못한 적이 있어, 실제 모듈 조립으로도 확인한다.
  async function compile(extra: { provide: string; useValue: unknown }[] = []) {
    const fake = createFakeAuthCodes();
    const moduleRef = await Test.createTestingModule({
      providers: [
        EmailCodeService,
        { provide: getModelToken(AuthCode.name), useValue: fake.model },
        { provide: JWT_CONFIG_TOKEN, useValue: JWT_CONFIG },
        ...extra,
      ],
    }).compile();
    return moduleRef.get(EmailCodeService);
  }

  it('난수 생성기를 따로 등록하지 않아도 서비스가 만들어진다 (서버의 실제 조립 방식)', async () => {
    const service = await compile();

    const result = await service.issue(EMAIL, 'signup');

    expect(result.ok && result.code).toMatch(/^\d{6}$/);
  });

  it('기본 난수는 실제로 값이 달라진다 (고정값이 아니다)', async () => {
    const service = await compile();
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(new Date(START.getTime() + i * 2 * EMAIL_CODE_SEND_WINDOW_MS));
      codes.add(await issued(service, `user${i}@example.com`));
    }

    expect(codes.size).toBeGreaterThan(10);
  });

  it('난수 생성기를 등록하면 그 값을 쓴다', async () => {
    const service = await compile([{ provide: EMAIL_CODE_RANDOM, useValue: () => 7 }]);

    const result = await service.issue(EMAIL, 'signup');

    expect(result).toEqual({ ok: true, code: '000007' });
  });
});
