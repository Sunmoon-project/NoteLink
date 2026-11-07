import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuthTokens } from '@notelink/shared';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SocialLoginAttemptDocument } from '../src/modules/auth/schemas/social-login-attempt.schema.js';
import type { UserDocument } from '../src/modules/auth/schemas/user.schema.js';
import {
  ACCOUNT_EXISTS,
  ACCOUNT_EXISTS_MESSAGE,
  matchesChallenge,
  SocialExchangeService,
} from '../src/modules/auth/social-login/social-exchange.service.js';
import { hashCode } from '../src/modules/auth/social-login/social-login.service.js';
import type { TokenService } from '../src/modules/auth/token.service.js';

// 앱이 만드는 값과 같은 방식: codeVerifier = hex(32바이트), code_challenge = base64url(SHA-256(verifier))
const codeVerifier = randomBytes(32).toString('hex');
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
const code = randomBytes(32).toString('base64url');

interface Attempt {
  _id: Types.ObjectId;
  provider: string;
  appState: string;
  codeChallenge: string;
  userId: Types.ObjectId | null;
  codeHash: string | null;
  outcome: string | null;
  expiresAt: Date;
}
interface UserRow {
  _id: Types.ObjectId;
  email: string | null;
  nickname: string;
  passwordHash?: string | null;
  socialAccounts: unknown[];
  deletedAt: Date | null;
  createdAt: Date;
}

type DeleteFilter = { provider: string; codeHash: string; expiresAt: { $gt: Date } };

function setup() {
  const userId = new Types.ObjectId();
  const attempts: Attempt[] = [];
  const users: UserRow[] = [
    {
      _id: userId,
      email: 'student@example.com',
      nickname: '김노트',
      passwordHash: '$2b$10$secret-hash-value',
      socialAccounts: [{ provider: 'google', providerUid: 'secret-uid' }],
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
  ];
  const calls = { findOneAndDelete: 0 };

  const attemptsModel = {
    // 찾으면서 동시에 지운다. 서비스가 넘긴 조건(제공자 · 코드 해시 · 만료)을 그대로 적용한다
    findOneAndDelete: (filter: DeleteFilter) => {
      calls.findOneAndDelete += 1;
      const i = attempts.findIndex(
        (a) =>
          a.provider === filter.provider &&
          a.codeHash === filter.codeHash &&
          a.expiresAt > filter.expiresAt.$gt,
      );
      if (i < 0) return Promise.resolve(null);
      return Promise.resolve(attempts.splice(i, 1)[0]!);
    },
  } as unknown as Model<SocialLoginAttemptDocument>;

  const usersModel = {
    findOne: (filter: { _id: Types.ObjectId; deletedAt: null }) =>
      Promise.resolve(
        users.find(
          (u) =>
            u._id.equals(filter._id) &&
            ('deletedAt' in filter ? u.deletedAt === filter.deletedAt : true),
        ) ?? null,
      ),
  } as unknown as Model<UserDocument>;

  const tokens = {
    issue: vi.fn((id: string) =>
      Promise.resolve({ accessToken: `access-for-${id}`, refreshToken: `refresh-for-${id}` }),
    ),
  } as unknown as TokenService & { issue: ReturnType<typeof vi.fn> };

  const service = new SocialExchangeService(attemptsModel, usersModel, tokens);

  /** 콜백이 끝난 뒤의 시도(코드가 발급된 상태)를 만든다 */
  const issued = (overrides: Partial<Attempt> = {}): Attempt => {
    const attempt: Attempt = {
      _id: new Types.ObjectId(),
      provider: 'google',
      appState: 'a'.repeat(32),
      codeChallenge,
      userId,
      codeHash: hashCode(code),
      outcome: 'signed_in',
      expiresAt: new Date(Date.now() + 2 * 60 * 1000),
      ...overrides,
    };
    attempts.push(attempt);
    return attempt;
  };

  return { service, attempts, users, tokens, calls, userId, issued };
}

const body = { code, codeVerifier };

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('matchesChallenge (PKCE S256)', () => {
  it('SHA-256(codeVerifier)의 base64url이 code_challenge와 같으면 true', () => {
    expect(matchesChallenge(codeVerifier, codeChallenge)).toBe(true);
  });

  it('다른 codeVerifier이면 false', () => {
    expect(matchesChallenge(randomBytes(32).toString('hex'), codeChallenge)).toBe(false);
  });

  it.each([
    ['빈 문자열', ''],
    ['너무 짧음', 'abc'],
    ['너무 긴 값', 'a'.repeat(500)],
    ['한 글자만 다름', `${codeChallenge.slice(0, -1)}${codeChallenge.endsWith('A') ? 'B' : 'A'}`],
  ])('code_challenge가 %s이면 false (길이가 달라도 오류 없이)', (_reason, challenge) => {
    expect(matchesChallenge(codeVerifier, challenge)).toBe(false);
  });

  it('codeVerifier 자체를 challenge로 내밀어도 통과하지 않는다 (plain 방식 거부)', () => {
    expect(matchesChallenge(codeVerifier, codeVerifier)).toBe(false);
  });
});

describe('SocialExchangeService.exchange', () => {
  describe('정상', () => {
    it('토큰 두 개와 사용자 정보를 돌려준다', async () => {
      const s = setup();
      s.issued();

      const result = await s.service.exchange(body);

      expect(result.accessToken).toBe(`access-for-${s.userId}`);
      expect(result.refreshToken).toBe(`refresh-for-${s.userId}`);
      expect(result.user).toMatchObject({
        _id: String(s.userId),
        nickname: '김노트',
        email: 'student@example.com',
      });
    });

    it('사용자 id로 토큰을 한 번만 발급한다', async () => {
      const s = setup();
      s.issued();

      await s.service.exchange(body);

      expect(s.tokens.issue).toHaveBeenCalledExactlyOnceWith(String(s.userId));
    });

    it('앱의 AuthTokens 스키마(packages/shared)로 파싱된다', async () => {
      const s = setup();
      s.issued();

      const result = await s.service.exchange(body);

      expect(AuthTokens.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
    });

    it('비밀번호 해시 · 소셜 연동 정보를 응답에 싣지 않는다', async () => {
      const s = setup();
      s.issued();

      const json = JSON.stringify(await s.service.exchange(body));

      expect(json).not.toContain('secret-hash-value');
      expect(json).not.toContain('secret-uid');
      expect(json).not.toContain('passwordHash');
      expect(json).not.toContain('socialAccounts');
    });
  });

  describe('1회용 코드', () => {
    it('성공하면 코드가 소모되어 같은 코드로 다시 교환할 수 없다', async () => {
      const s = setup();
      s.issued();
      await s.service.exchange(body);

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).toHaveBeenCalledTimes(1);
    });

    it('동시에 두 번 교환해도 한 번만 성공한다', async () => {
      const s = setup();
      s.issued();

      const results = await Promise.allSettled([
        s.service.exchange(body),
        s.service.exchange(body),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(s.tokens.issue).toHaveBeenCalledTimes(1);
    });

    it('동시에 20번 교환해도 토큰은 한 번만 발급된다', async () => {
      const s = setup();
      s.issued();

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => s.service.exchange(body)),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(s.tokens.issue).toHaveBeenCalledTimes(1);
    });

    it('없는 코드이면 400이다', async () => {
      const s = setup();
      s.issued();

      const error = await failure(
        s.service.exchange({ code: randomBytes(32).toString('base64url'), codeVerifier }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('만료된 코드이면 400이다', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const s = setup();
      s.issued({ expiresAt: new Date('2026-01-01T00:02:00Z') });
      vi.setSystemTime(new Date('2026-01-01T00:02:01Z')); // 2분 + 1초 뒤

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('만료 직전(2분 이내)에는 성공한다', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const s = setup();
      s.issued({ expiresAt: new Date('2026-01-01T00:02:00Z') });
      vi.setSystemTime(new Date('2026-01-01T00:01:59Z'));

      await expect(s.service.exchange(body)).resolves.toHaveProperty('accessToken');
    });

    it('다른 제공자의 시도에 걸린 코드는 구글 교환에서 쓸 수 없다', async () => {
      const s = setup();
      s.issued({ provider: 'kakao' });

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('아직 코드가 발급되지 않은(codeHash가 비어 있는) 시도는 교환할 수 없다', async () => {
      const s = setup();
      s.issued({ codeHash: null, outcome: null, userId: null });

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('코드는 원문이 아니라 해시로 찾는다 (DB에 해시만 있어도 동작)', async () => {
      const s = setup();
      const attempt = s.issued();

      await s.service.exchange(body);

      expect(attempt.codeHash).toBe(hashCode(code));
      expect(attempt.codeHash).not.toBe(code);
    });
  });

  describe('PKCE (로그인을 시작한 앱이 맞는지)', () => {
    it('codeVerifier가 틀리면 400이고 토큰을 발급하지 않는다', async () => {
      const s = setup();
      s.issued();

      const error = await failure(
        s.service.exchange({ code, codeVerifier: randomBytes(32).toString('hex') }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('PKCE가 틀려도 코드는 소모된다 (가로챈 쪽이 verifier를 여러 번 추측할 수 없다)', async () => {
      const s = setup();
      s.issued();
      await failure(s.service.exchange({ code, codeVerifier: randomBytes(32).toString('hex') }));

      // 이제 올바른 verifier로도 같은 코드를 쓸 수 없다
      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).not.toHaveBeenCalled();
      expect(s.attempts).toHaveLength(0);
    });

    it('틀린 verifier로 100번 시도해도 첫 시도에서 코드가 소모되므로 두 번째부터는 코드를 찾지 못한다', async () => {
      const s = setup();
      s.issued();

      for (let i = 0; i < 100; i++) {
        await failure(s.service.exchange({ code, codeVerifier: randomBytes(32).toString('hex') }));
      }

      expect(s.calls.findOneAndDelete).toBe(100);
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('코드 없음 · 만료 · PKCE 불일치는 같은 응답이다 (공격자에게 단서를 주지 않는다)', async () => {
      const responses: unknown[] = [];

      const none = setup();
      responses.push(
        ((await failure(none.service.exchange(body))) as BadRequestException).getResponse(),
      );

      const wrong = setup();
      wrong.issued();
      responses.push(
        (
          (await failure(
            wrong.service.exchange({ code, codeVerifier: randomBytes(32).toString('hex') }),
          )) as BadRequestException
        ).getResponse(),
      );

      const expired = setup();
      expired.issued({ expiresAt: new Date(Date.now() - 1000) });
      responses.push(
        ((await failure(expired.service.exchange(body))) as BadRequestException).getResponse(),
      );

      expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
    });
  });

  describe('이메일이 겹친 로그인 (account_exists)', () => {
    it('409 { code: ACCOUNT_EXISTS, message } 이고 토큰을 발급하지 않는다', async () => {
      const s = setup();
      s.issued({ outcome: 'account_exists', userId: null });

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getStatus()).toBe(409);
      expect((error as ConflictException).getResponse()).toEqual({
        code: 'ACCOUNT_EXISTS',
        message: '이 이메일로 가입한 계정이 있다면 처음 가입한 방법으로 로그인해 주세요',
      });
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('안내 문구가 보수적이다: 계정이 있다고 단정하지 않고 이메일 · 가입 방법을 알려 주지 않는다', () => {
      expect(ACCOUNT_EXISTS).toBe('ACCOUNT_EXISTS');
      expect(ACCOUNT_EXISTS_MESSAGE).toContain('있다면');
      expect(ACCOUNT_EXISTS_MESSAGE).not.toMatch(/@|카카오|네이버|구글|Google|이메일 계정/);
    });

    it('이 경우에도 PKCE를 먼저 확인한다 (남의 코드로 계정 존재 여부를 알아낼 수 없다)', async () => {
      const s = setup();
      s.issued({ outcome: 'account_exists', userId: null });

      const error = await failure(
        s.service.exchange({ code, codeVerifier: randomBytes(32).toString('hex') }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error).not.toBeInstanceOf(ConflictException);
    });

    it('코드는 소모된다 (같은 코드로 다시 안내를 받지 않는다)', async () => {
      const s = setup();
      s.issued({ outcome: 'account_exists', userId: null });
      await failure(s.service.exchange(body));

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
    });
  });

  describe('비정상 상태', () => {
    it.each([
      ['결과가 비어 있음', { outcome: null }],
      ['알 수 없는 결과', { outcome: 'weird' }],
      ['로그인 결과인데 사용자가 없음', { outcome: 'signed_in', userId: null }],
    ])('%s이면 400이고 토큰을 발급하지 않는다', async (_reason, overrides) => {
      const s = setup();
      s.issued(overrides as Partial<Attempt>);

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('콜백 뒤에 사용자가 탈퇴했으면 400이고 토큰을 발급하지 않는다', async () => {
      const s = setup();
      s.issued();
      s.users[0]!.deletedAt = new Date();

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('사용자가 사라졌으면(문서 없음) 400이다', async () => {
      const s = setup();
      s.issued({ userId: new Types.ObjectId() });

      const error = await failure(s.service.exchange(body));

      expect(error).toBeInstanceOf(BadRequestException);
      expect(s.tokens.issue).not.toHaveBeenCalled();
    });

    it('토큰 발급이 실패하면 그 오류를 그대로 던진다 (이미 코드는 소모되었다)', async () => {
      const s = setup();
      s.issued();
      s.tokens.issue.mockRejectedValueOnce(new Error('DB 쓰기 실패'));

      await expect(s.service.exchange(body)).rejects.toThrow('DB 쓰기 실패');

      expect(s.attempts).toHaveLength(0);
    });
  });
});
