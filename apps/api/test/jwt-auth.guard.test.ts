import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtConfig } from '../src/config/jwt.config.js';
import {
  type AuthenticatedRequest,
  JwtAuthGuard,
  readBearerToken,
} from '../src/modules/auth/jwt-auth.guard.js';
import type { RefreshTokenDocument } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';

const CONFIG: JwtConfig = {
  accessSecret: 'a'.repeat(32),
  refreshSecret: 'b'.repeat(32),
  accessTTL: '15m',
  refreshTTL: '14d',
};

const jwt = new JwtService();
const userId = new Types.ObjectId().toHexString();
const accessToken = () =>
  jwt.sign({ sub: userId }, { secret: CONFIG.accessSecret, expiresIn: '15m' });

/** verifyAccess는 DB를 쓰지 않는다. 쓰이면 바로 알 수 있도록 모든 호출이 실패하는 모델을 넣는다 */
function service() {
  const model = new Proxy(
    {},
    { get: () => () => Promise.reject(new Error('DB를 읽으면 안 된다')) },
  );
  return new TokenService(jwt, CONFIG, model as Model<RefreshTokenDocument>);
}

function contextOf(authorization: string | string[] | undefined) {
  const request: AuthenticatedRequest = { headers: { authorization } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { request, context };
}

async function rejection(promise: Promise<unknown>): Promise<UnauthorizedException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UnauthorizedException);
    return error as UnauthorizedException;
  }
  throw new Error('거부되어야 하는데 통과했다');
}

const EXPIRED_BODY = { code: 'AUTH_TOKEN_EXPIRED', message: '다시 로그인해 주세요' };

afterEach(() => {
  vi.useRealTimers();
});

describe('readBearerToken', () => {
  it('Bearer 토큰을 꺼낸다', () => {
    expect(readBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it.each(['bearer abc', 'BEARER abc', 'BeArEr abc'])(
    '스킴은 대소문자를 구분하지 않는다 (%s)',
    (header) => {
      expect(readBearerToken(header)).toBe('abc');
    },
  );

  it.each([
    ['헤더 없음', undefined],
    ['빈 문자열', ''],
    ['스킴만', 'Bearer'],
    ['스킴 뒤 공백만', 'Bearer '],
    ['다른 스킴(Basic)', 'Basic abc'],
    ['토큰만(스킴 없음)', 'abc.def.ghi'],
    ['공백이 둘 이상', 'Bearer  abc'],
    ['토큰 사이에 공백', 'Bearer abc def'],
    ['앞 공백', ' Bearer abc'],
    ['여러 번 온 헤더(배열)', ['Bearer abc', 'Bearer def']],
    ['줄바꿈 포함', 'Bearer abc\n'],
  ])('%s이면 null이다', (_reason, header) => {
    expect(readBearerToken(header)).toBeNull();
  });
});

describe('TokenService.verifyAccess', () => {
  it('유효한 access 토큰이면 사용자 id를 돌려준다', async () => {
    await expect(service().verifyAccess(accessToken())).resolves.toEqual({ userId });
  });

  it('DB를 읽지 않고 서명과 만료만 본다', async () => {
    await expect(service().verifyAccess(accessToken())).resolves.toBeDefined();
  });

  it('만료된 토큰은 401 AUTH_TOKEN_EXPIRED이다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = accessToken();
    vi.setSystemTime(new Date('2026-01-01T00:15:01Z')); // 15분 + 1초 뒤

    const error = await rejection(service().verifyAccess(token));

    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toEqual(EXPIRED_BODY);
  });

  it('만료 직전(15분 이내)에는 통과한다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const token = accessToken();
    vi.setSystemTime(new Date('2026-01-01T00:14:59Z'));

    await expect(service().verifyAccess(token)).resolves.toEqual({ userId });
  });

  it('다른 시크릿으로 서명한 토큰(위조)은 거부한다', async () => {
    const forged = jwt.sign({ sub: userId }, { secret: 'z'.repeat(32), expiresIn: '15m' });

    expect((await rejection(service().verifyAccess(forged))).getResponse()).toEqual(EXPIRED_BODY);
  });

  it('refresh 토큰을 access 자리에 내밀면 거부한다 (시크릿이 다르다)', async () => {
    const refresh = jwt.sign(
      { sub: userId, jti: 'j' },
      { secret: CONFIG.refreshSecret, expiresIn: '14d' },
    );

    expect((await rejection(service().verifyAccess(refresh))).getResponse()).toEqual(EXPIRED_BODY);
  });

  it('서명 부분을 바꾼 토큰은 거부한다', async () => {
    const [h, p, s] = accessToken().split('.');
    const tampered = `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith('A') ? 'BB' : 'AA'}`;

    await rejection(service().verifyAccess(tampered));
  });

  it('내용(사용자 id)을 바꾼 토큰은 거부한다', async () => {
    const [h, , s] = accessToken().split('.');
    const otherPayload = Buffer.from(
      JSON.stringify({ sub: new Types.ObjectId().toHexString(), exp: 9999999999 }),
    ).toString('base64url');

    await rejection(service().verifyAccess(`${h}.${otherPayload}.${s}`));
  });

  it('alg가 none인 토큰(서명 없음)은 거부한다', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: userId, exp: 9999999999 })).toString(
      'base64url',
    );

    await rejection(service().verifyAccess(`${header}.${payload}.`));
  });

  it.each([
    ['빈 문자열', ''],
    ['JWT 모양이 아님', 'not-a-jwt'],
    ['점이 두 개가 아님', 'a.b'],
    ['깨진 base64', 'a.b.c'],
  ])('%s이면 거부한다', async (_reason, token) => {
    expect((await rejection(service().verifyAccess(token))).getResponse()).toEqual(EXPIRED_BODY);
  });

  it.each([
    ['sub가 없음', {}],
    ['sub가 숫자', { sub: 123 }],
    ['sub가 객체', { sub: { $ne: null } }],
    ['sub가 사용자 id 형식이 아님', { sub: 'admin' }],
    ['sub가 23자리', { sub: 'a'.repeat(23) }],
    ['sub가 25자리', { sub: 'a'.repeat(25) }],
    ['sub에 대문자(ObjectId는 소문자 16진수)', { sub: 'A'.repeat(24) }],
    ['sub가 빈 문자열', { sub: '' }],
  ])('서명이 맞아도 %s이면 거부한다', async (_reason, payload) => {
    const signed = jwt.sign(payload, { secret: CONFIG.accessSecret, expiresIn: '15m' });

    expect((await rejection(service().verifyAccess(signed))).getResponse()).toEqual(EXPIRED_BODY);
  });
});

describe('JwtAuthGuard', () => {
  it('유효한 Bearer 토큰이면 통과시키고 request.user에 사용자 id를 붙인다', async () => {
    const { request, context } = contextOf(`Bearer ${accessToken()}`);

    await expect(new JwtAuthGuard(service()).canActivate(context)).resolves.toBe(true);

    expect(request.user).toEqual({ userId });
  });

  it.each([
    ['헤더 없음', undefined],
    ['빈 헤더', ''],
    ['스킴만', 'Bearer'],
    ['다른 스킴', 'Basic dXNlcjpwYXNz'],
    ['토큰만', accessToken()],
    ['헤더가 여러 번', [`Bearer ${accessToken()}`, `Bearer ${accessToken()}`]],
  ])('%s이면 401 AUTH_TOKEN_EXPIRED로 거부하고 사용자를 붙이지 않는다', async (_reason, header) => {
    const { request, context } = contextOf(header);

    const error = await rejection(new JwtAuthGuard(service()).canActivate(context));

    expect(error.getResponse()).toEqual(EXPIRED_BODY);
    expect(request.user).toBeUndefined();
  });

  it('잘못된 토큰도 같은 응답이다 (사유를 구분해 알려 주지 않는다)', async () => {
    const bodies: unknown[] = [];
    for (const header of [
      undefined,
      'Bearer garbage',
      `Bearer ${jwt.sign({ sub: userId }, { secret: 'z'.repeat(32) })}`,
    ]) {
      const { context } = contextOf(header);
      bodies.push(
        (await rejection(new JwtAuthGuard(service()).canActivate(context))).getResponse(),
      );
    }

    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it('거부된 요청의 오류에 토큰 값을 넣지 않는다', async () => {
    const bad = 'Bearer secret-looking-token-value';
    const { context } = contextOf(bad);

    const error = await rejection(new JwtAuthGuard(service()).canActivate(context));

    expect(JSON.stringify(error.getResponse())).not.toContain('secret-looking-token-value');
  });
});
