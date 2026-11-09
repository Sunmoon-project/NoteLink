import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMAIL_PROOF_AUDIENCE,
  EmailProofService,
} from '../src/modules/auth/app-login/email-proof.service.js';
import { EMAIL_PROOF_TTL_MS } from '../src/modules/auth/app-login/email-code.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';

const CONFIG = {
  accessSecret: 'test-access-secret-0123456789abcdef',
  refreshSecret: 'test-refresh-secret-0123456789abcdef',
  accessTTL: '15m',
  refreshTTL: '14d',
} as never;

const START = new Date('2026-01-01T00:00:00Z');
const EMAIL = 'student@example.com';
const CLAIMS = { email: EMAIL, purpose: 'signup' as const, verifiedAt: START };

const jwt = new JwtService();
const service = (config = CONFIG) => new EmailProofService(jwt, config);

const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

/** 서명 부분만 바꿔 위조한 토큰을 만든다 */
const tamperSignature = (token: string) => {
  const [h, p, s] = token.split('.') as [string, string, string];
  return `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
};

/** 본문(payload)만 바꾸고 기존 서명은 그대로 둔 토큰 */
const tamperPayload = (token: string, change: Record<string, unknown>) => {
  const [h, , s] = token.split('.') as [string, string, string];
  const next = Buffer.from(JSON.stringify({ ...decode(token), ...change })).toString('base64url');
  return `${h}.${next}.${s}`;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EmailProofService.issue', () => {
  it('JWT 형식의 토큰과 수명(초)을 돌려준다', async () => {
    const result = await service().issue(CLAIMS);

    expect(result.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(result.expiresInSeconds).toBe(600);
  });

  it('수명은 10분이다', () => {
    expect(EMAIL_PROOF_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('토큰에는 이메일 · 용도 · 인증 시각 · 용도 표시(aud) · 발급과 만료 시각이 들어 있다', async () => {
    const { token } = await service().issue(CLAIMS);

    expect(decode(token)).toEqual({
      email: EMAIL,
      purpose: 'signup',
      vat: START.getTime(),
      aud: EMAIL_PROOF_AUDIENCE,
      iat: START.getTime() / 1000,
      exp: START.getTime() / 1000 + 600,
    });
  });

  it('sub를 넣지 않는다 (access 토큰 검증은 sub를 사용자 id로 요구하므로 access 자리에서 통과할 수 없다)', async () => {
    const { token } = await service().issue(CLAIMS);

    expect(decode(token)).not.toHaveProperty('sub');
  });

  it('HS256으로 서명한다', async () => {
    const { token } = await service().issue(CLAIMS);

    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())).toMatchObject({
      alg: 'HS256',
    });
  });

  it('비밀번호 등 증표에 필요 없는 값은 담지 않는다', async () => {
    const { token } = await service().issue(CLAIMS);

    expect(Object.keys(decode(token)).sort()).toEqual(
      ['aud', 'email', 'exp', 'iat', 'purpose', 'vat'].sort(),
    );
  });
});

describe('EmailProofService.verify', () => {
  describe('정상', () => {
    it('발급한 증표를 검증하면 내용을 그대로 돌려준다', async () => {
      const { token } = await service().issue(CLAIMS);

      expect(await service().verify(token)).toEqual({ ok: true, ...CLAIMS });
    });

    it('인증 시각을 Date로 복원한다 (밀리초까지)', async () => {
      const at = new Date('2026-01-01T00:00:01.234Z');
      const { token } = await service().issue({ ...CLAIMS, verifiedAt: at });

      const result = await service().verify(token);

      expect(result.ok && result.verifiedAt.getTime()).toBe(at.getTime());
    });

    it('서버가 다시 시작돼도(서비스를 새로 만들어도) 같은 비밀값이면 검증된다 (상태를 저장하지 않는다)', async () => {
      const { token } = await service().issue(CLAIMS);

      expect((await service().verify(token)).ok).toBe(true);
    });
  });

  describe('수명', () => {
    it('만료 1초 전까지는 유효하다', async () => {
      const { token } = await service().issue(CLAIMS);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_PROOF_TTL_MS - 1_000));

      expect((await service().verify(token)).ok).toBe(true);
    });

    it('만료 시각이 지나면 expired이다', async () => {
      const { token } = await service().issue(CLAIMS);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_PROOF_TTL_MS + 1_000));

      expect(await service().verify(token)).toEqual({ ok: false, reason: 'expired' });
    });

    it('만료와 위조는 서로 다른 결과로 구분한다 (만료만 "다시 인증해 달라"고 안내할 수 있다)', async () => {
      const { token } = await service().issue(CLAIMS);
      vi.setSystemTime(new Date(START.getTime() + EMAIL_PROOF_TTL_MS + 5_000));

      const expired = await service().verify(token);
      const forged = await service().verify(tamperSignature(token));

      expect(expired).toEqual({ ok: false, reason: 'expired' });
      expect(forged).toEqual({ ok: false, reason: 'invalid' });
    });
  });

  describe('위조', () => {
    it('서명을 바꾸면 invalid이다', async () => {
      const { token } = await service().issue(CLAIMS);

      expect(await service().verify(tamperSignature(token))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('본문(이메일)을 바꾸고 서명은 그대로 두면 invalid이다 (다른 이메일로 가입하려는 시도)', async () => {
      const { token } = await service().issue(CLAIMS);

      expect(await service().verify(tamperPayload(token, { email: 'attacker@evil.com' }))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('본문(인증 시각 · 수명)을 바꿔도 invalid이다', async () => {
      const { token } = await service().issue(CLAIMS);

      expect((await service().verify(tamperPayload(token, { vat: 1 }))).ok).toBe(false);
      expect((await service().verify(tamperPayload(token, { exp: 9_999_999_999 }))).ok).toBe(false);
    });

    it('다른 비밀값으로 서명한 증표는 invalid이다', async () => {
      const other = service({
        ...(CONFIG as object),
        accessSecret: 'another-access-secret-0123456789a',
      } as never);
      const { token } = await other.issue(CLAIMS);

      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('서명 알고리즘이 none인 토큰은 거부한다', async () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          email: EMAIL,
          purpose: 'signup',
          vat: START.getTime(),
          aud: EMAIL_PROOF_AUDIENCE,
          exp: START.getTime() / 1000 + 600,
        }),
      ).toString('base64url');

      expect(await service().verify(`${header}.${payload}.`)).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('HS256이 아닌 알고리즘(HS512)으로 서명한 토큰은 같은 비밀값이어도 거부한다', async () => {
      const secret = (service() as unknown as { secret: string }).secret;
      const token = await jwt.signAsync(
        { email: EMAIL, purpose: 'signup', vat: START.getTime() },
        { secret, algorithm: 'HS512', audience: EMAIL_PROOF_AUDIENCE, expiresIn: 600 },
      );

      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it.each([
      ['빈 문자열', ''],
      ['점이 없음', 'notatoken'],
      ['점이 한 개', 'a.b'],
      ['깨진 base64', '!!!.@@@.###'],
      ['공백', '   '],
    ])('형식이 깨진 값(%s)은 invalid이다', async (_reason, token) => {
      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });
  });

  describe('내용 모양 검사 (서명이 맞아도 내용이 이상하면 거부한다)', () => {
    /** 같은 비밀값으로 서명하되 내용만 바꾼 증표를 만든다 */
    const signed = (payload: Record<string, unknown>, options: Record<string, unknown> = {}) => {
      const secret = (service() as unknown as { secret: string }).secret;
      return jwt.signAsync(payload, {
        secret,
        algorithm: 'HS256',
        audience: EMAIL_PROOF_AUDIENCE,
        expiresIn: 600,
        ...options,
      });
    };
    const valid = { email: EMAIL, purpose: 'signup', vat: START.getTime() };

    it('내용이 모두 맞으면 통과한다 (기준선)', async () => {
      expect((await service().verify(await signed(valid))).ok).toBe(true);
    });

    it.each([
      ['email 없음', { ...valid, email: undefined }],
      ['email 빈 문자열', { ...valid, email: '' }],
      ['email 숫자', { ...valid, email: 123 }],
      ['purpose 없음', { ...valid, purpose: undefined }],
      ['purpose가 알 수 없는 값', { ...valid, purpose: 'password-reset' }],
      ['purpose 숫자', { ...valid, purpose: 1 }],
      ['vat 없음', { ...valid, vat: undefined }],
      ['vat 문자열', { ...valid, vat: String(START.getTime()) }],
      ['vat 0', { ...valid, vat: 0 }],
      ['vat 음수', { ...valid, vat: -5 }],
      ['vat 소수', { ...valid, vat: 1.5 }],
      ['vat가 안전한 정수 범위 밖', { ...valid, vat: 2 ** 60 }],
    ])('%s이면 invalid이다', async (_reason, payload) => {
      expect(await service().verify(await signed(payload))).toEqual({
        ok: false,
        reason: 'invalid',
      });
    });

    it('용도 표시(aud)가 없으면 invalid이다', async () => {
      const secret = (service() as unknown as { secret: string }).secret;
      const token = await jwt.signAsync(valid, { secret, algorithm: 'HS256', expiresIn: 600 });

      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('용도 표시(aud)가 다르면 같은 키로 서명했어도 invalid이다', async () => {
      const token = await signed(valid, { audience: 'notelink:something-else' });

      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('수명을 10분보다 길게 부풀린 증표는 같은 키로 서명했어도 거부한다', async () => {
      const secret = (service() as unknown as { secret: string }).secret;
      const token = await jwt.signAsync(valid, {
        secret,
        algorithm: 'HS256',
        audience: EMAIL_PROOF_AUDIENCE,
        expiresIn: 601, // 서버가 발급하는 수명(600초)보다 1초 길다
      });

      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('수명이 정확히 10분인 증표는 통과한다 (경계)', async () => {
      const secret = (service() as unknown as { secret: string }).secret;
      const token = await jwt.signAsync(valid, {
        secret,
        algorithm: 'HS256',
        audience: EMAIL_PROOF_AUDIENCE,
        expiresIn: 600,
      });

      expect((await service().verify(token)).ok).toBe(true);
    });

    it('발급 시각(iat)이 없는 증표는 거부한다', async () => {
      const secret = (service() as unknown as { secret: string }).secret;
      const token = await jwt.signAsync(valid, {
        secret,
        algorithm: 'HS256',
        audience: EMAIL_PROOF_AUDIENCE,
        expiresIn: 600,
        noTimestamp: true,
      });

      expect(decode(token)).not.toHaveProperty('iat');
      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });

    it('만료 시각(exp)이 없는 증표는 거부한다 (영원히 유효한 증표를 허용하지 않는다)', async () => {
      const secret = (service() as unknown as { secret: string }).secret;
      const token = await jwt.signAsync(valid, {
        secret,
        algorithm: 'HS256',
        audience: EMAIL_PROOF_AUDIENCE,
      });

      expect(decode(token)).not.toHaveProperty('exp');
      expect(await service().verify(token)).toEqual({ ok: false, reason: 'invalid' });
    });
  });
});

describe('발급 형식을 못박는다 (실수로 바뀌면 이미 발급된 증표가 모두 무효가 된다)', () => {
  it('용도 표시(aud)는 "notelink:email-proof"이다', () => {
    expect(EMAIL_PROOF_AUDIENCE).toBe('notelink:email-proof');
  });

  it('서명 키는 access 비밀값에서 "notelink:email-proof:v1"로 파생한 값이다 (독립적으로 계산한 값과 비교)', async () => {
    const { token } = await service().issue(CLAIMS);

    // 같은 입력을 외부에서 계산한 파생 키로 검증하면 통과해야 한다
    const verified = await jwt.verifyAsync(token, {
      secret: 'e5239a54fe63c3794aed1ebebf489fd19893c2fa9e0813ca59cd1730b7d66a02',
      algorithms: ['HS256'],
      audience: 'notelink:email-proof',
    });
    expect(verified).toMatchObject({ email: EMAIL });
  });

  it('다른 도메인으로 파생한 키로는 검증되지 않는다', async () => {
    const { token } = await service().issue(CLAIMS);

    await expect(
      jwt.verifyAsync(token, { secret: 'a'.repeat(64), algorithms: ['HS256'] }),
    ).rejects.toThrow();
  });
});

describe('다른 토큰과 서로 대신 쓸 수 없다', () => {
  // 실제 TokenService로 access · refresh 토큰을 만들어 교차 검증한다
  const access = async () => {
    const tokens = new TokenService(jwt, CONFIG, {
      create: () => Promise.resolve({ _id: new Types.ObjectId() }),
    } as never);
    return tokens.issue(new Types.ObjectId().toHexString());
  };
  const tokenService = () =>
    new TokenService(jwt, CONFIG, {
      create: () => Promise.resolve({ _id: new Types.ObjectId() }),
    } as never);

  it('access 토큰은 증표로 쓸 수 없다', async () => {
    const { accessToken } = await access();

    expect(await service().verify(accessToken)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refresh 토큰은 증표로 쓸 수 없다', async () => {
    const { refreshToken } = await access();

    expect(await service().verify(refreshToken)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('증표는 access 토큰으로 쓸 수 없다 (보호된 주소를 통과하지 못한다)', async () => {
    const { token } = await service().issue(CLAIMS);

    await expect(tokenService().verifyAccess(token)).rejects.toMatchObject({
      response: { code: 'AUTH_TOKEN_EXPIRED' },
    });
  });

  it('증표는 refresh 토큰으로도 쓸 수 없다 (갱신에 내밀어도 통과하지 못한다)', async () => {
    const { token } = await service().issue(CLAIMS);

    await expect(tokenService().rotate(token)).rejects.toMatchObject({
      response: { code: 'AUTH_TOKEN_EXPIRED' },
    });
  });

  it('access 토큰 비밀값으로 sub만 넣어 만든 토큰도 증표 키가 달라 통과하지 못한다', async () => {
    const forged = await jwt.signAsync(
      { email: EMAIL, purpose: 'signup', vat: START.getTime() },
      {
        secret: 'test-access-secret-0123456789abcdef',
        algorithm: 'HS256',
        audience: EMAIL_PROOF_AUDIENCE,
        expiresIn: 600,
      },
    );

    expect(await service().verify(forged)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('비밀값이 오류에 새지 않는다', () => {
  it('실패 결과에는 이유 코드만 있다 (토큰 · 비밀값 · 오류 문구 없음)', async () => {
    const { token } = await service().issue(CLAIMS);
    const result = await service().verify(tamperSignature(token));

    expect(Object.keys(result).sort()).toEqual(['ok', 'reason']);
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
