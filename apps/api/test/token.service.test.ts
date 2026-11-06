import { createHash } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtConfig } from '../src/config/jwt.config.js';
import type { RefreshTokenDocument } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';

const CONFIG: JwtConfig = {
  accessSecret: 'a'.repeat(32),
  refreshSecret: 'b'.repeat(32),
  accessTTL: '15m',
  refreshTTL: '14d',
};

interface Row {
  userId: Types.ObjectId;
  tokenHash: string;
  device?: Record<string, unknown>;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * refresh_tokens 컬렉션을 메모리로 흉내 낸다. TokenService가 쓰는 세 가지(create · findOneAndUpdate · updateOne)만 만든다.
 * findOneAndUpdate는 실제 Mongoose처럼 "바뀌기 전" 문서를 돌려주고, 찾기와 고치기를 한 번에 한다.
 */
function createFakeModel() {
  const rows: Row[] = [];
  // 서비스가 넘긴 조건만 그대로 적용한다. 조건이 빠지면 그만큼 더 많이 걸려서 테스트가 잡아낸다
  const matches = (
    row: Row,
    f: { tokenHash: string; revokedAt?: null; expiresAt?: { $gt: Date } },
  ) =>
    row.tokenHash === f.tokenHash &&
    (!('revokedAt' in f) || row.revokedAt === f.revokedAt) &&
    (!f.expiresAt || row.expiresAt > f.expiresAt.$gt);

  const model = {
    create: (data: Omit<Row, 'revokedAt'>) => {
      if (rows.some((r) => r.tokenHash === data.tokenHash)) {
        return Promise.reject(new Error('E11000 duplicate key (tokenHash)'));
      }
      rows.push({ ...data, revokedAt: null });
      return Promise.resolve(data);
    },
    findOneAndUpdate: (filter: Parameters<typeof matches>[1], update: { revokedAt: Date }) => {
      const row = rows.find((r) => matches(r, filter));
      if (!row) return Promise.resolve(null);
      const before = { ...row };
      row.revokedAt = update.revokedAt;
      return Promise.resolve(before);
    },
    updateOne: (filter: Parameters<typeof matches>[1], update: { revokedAt: Date }) => {
      const row = rows.find((r) => matches(r, filter));
      if (row) row.revokedAt = update.revokedAt;
      return Promise.resolve({ modifiedCount: row ? 1 : 0 });
    },
  };
  return { rows, model: model as unknown as Model<RefreshTokenDocument> };
}

function setup() {
  const fake = createFakeModel();
  const jwt = new JwtService();
  const service = new TokenService(jwt, CONFIG, fake.model);
  return { service, jwt, rows: fake.rows };
}

const newUserId = () => new Types.ObjectId().toHexString();
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/** TOKEN_EXPIRED 코드가 담긴 401인지 확인한다 */
async function expectUnauthorized(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(UnauthorizedException);
  await expect(promise).rejects.toMatchObject({ response: { code: 'AUTH_TOKEN_EXPIRED' } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TokenService.issue', () => {
  it('access · refresh 토큰을 각자의 시크릿으로 서명해 사용자 id를 담는다', async () => {
    const { service, jwt } = setup();
    const userId = newUserId();

    const { accessToken, refreshToken } = await service.issue(userId);

    const access = await jwt.verifyAsync<{ sub: string }>(accessToken, {
      secret: CONFIG.accessSecret,
    });
    const refresh = await jwt.verifyAsync<{ sub: string }>(refreshToken, {
      secret: CONFIG.refreshSecret,
    });
    expect(access.sub).toBe(userId);
    expect(refresh.sub).toBe(userId);
  });

  it('access 토큰은 refresh 시크릿으로, refresh 토큰은 access 시크릿으로 검증되지 않는다', async () => {
    const { service, jwt } = setup();

    const { accessToken, refreshToken } = await service.issue(newUserId());

    await expect(jwt.verifyAsync(accessToken, { secret: CONFIG.refreshSecret })).rejects.toThrow();
    await expect(jwt.verifyAsync(refreshToken, { secret: CONFIG.accessSecret })).rejects.toThrow();
  });

  it('DB에는 refresh 토큰 원문이 아니라 해시를 저장한다', async () => {
    const { service, rows } = setup();
    const userId = newUserId();

    const { refreshToken } = await service.issue(userId, { platform: 'ios' });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256(refreshToken));
    expect(JSON.stringify(rows[0])).not.toContain(refreshToken);
    expect(rows[0]!.userId.toHexString()).toBe(userId);
    expect(rows[0]!.device).toEqual({ platform: 'ios' });
    expect(rows[0]!.revokedAt).toBeNull();
  });

  it('refresh 토큰의 만료 시각을 토큰의 exp와 맞춰 저장한다', async () => {
    const { service, jwt, rows } = setup();

    const { refreshToken } = await service.issue(newUserId());

    const { exp } = jwt.decode<{ exp: number }>(refreshToken);
    expect(rows[0]!.expiresAt.getTime()).toBe(exp * 1000);
  });

  it('같은 사용자가 같은 순간에 여러 기기로 로그인해도 토큰이 서로 다르다', async () => {
    const { service, rows } = setup();
    const userId = newUserId();

    const [phone, tablet] = await Promise.all([
      service.issue(userId, { name: 'phone' }),
      service.issue(userId, { name: 'tablet' }),
    ]);

    expect(phone.refreshToken).not.toBe(tablet.refreshToken);
    expect(rows).toHaveLength(2);
  });
});

describe('TokenService.rotate', () => {
  it('새 토큰 한 쌍을 주고, 쓴 refresh 토큰은 폐기한다', async () => {
    const { service, rows } = setup();
    const userId = newUserId();
    const first = await service.issue(userId);

    const second = await service.rotate(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
    expect(rows[1]!.revokedAt).toBeNull();
  });

  it('기기 정보를 새 토큰으로 이어 간다', async () => {
    const { service, rows } = setup();
    const first = await service.issue(newUserId(), { name: 'tablet' });

    await service.rotate(first.refreshToken);

    expect(rows[1]!.device).toEqual({ name: 'tablet' });
  });

  it('이미 쓴 refresh 토큰으로 다시 요청하면 거부한다', async () => {
    const { service } = setup();
    const first = await service.issue(newUserId());
    await service.rotate(first.refreshToken);

    await expectUnauthorized(service.rotate(first.refreshToken));
  });

  it('같은 토큰으로 동시에 두 번 요청하면 한 번만 성공한다', async () => {
    const { service } = setup();
    const first = await service.issue(newUserId());

    const results = await Promise.allSettled([
      service.rotate(first.refreshToken),
      service.rotate(first.refreshToken),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('형식이 깨진 토큰은 거부한다', async () => {
    const { service } = setup();

    await expectUnauthorized(service.rotate('not-a-jwt'));
  });

  it('access 토큰을 refresh 자리에 내밀면 거부한다', async () => {
    const { service } = setup();
    const { accessToken } = await service.issue(newUserId());

    await expectUnauthorized(service.rotate(accessToken));
  });

  it('서명은 맞지만 DB에 없는 토큰은 거부한다', async () => {
    const { service, jwt } = setup();
    const forged = await jwt.signAsync(
      { sub: newUserId() },
      { secret: CONFIG.refreshSecret, expiresIn: '14d' },
    );

    await expectUnauthorized(service.rotate(forged));
  });

  it('만료된 refresh 토큰은 거부한다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { service } = setup();
    const { refreshToken } = await service.issue(newUserId());

    vi.setSystemTime(new Date('2026-01-16T00:00:00Z')); // 14일 + 1일

    await expectUnauthorized(service.rotate(refreshToken));
  });
  it('토큰 자체는 유효해도 DB의 만료 시각이 지났으면 거부한다', async () => {
    const { service, rows } = setup();
    const { refreshToken } = await service.issue(newUserId());
    rows[0]!.expiresAt = new Date(Date.now() - 1000);

    await expectUnauthorized(service.rotate(refreshToken));
  });
});

describe('TokenService.revoke', () => {
  it('그 기기의 토큰만 폐기하고, 폐기한 토큰으로는 더 이상 갱신하지 못한다', async () => {
    const { service, rows } = setup();
    const userId = newUserId();
    const phone = await service.issue(userId, { name: 'phone' });
    const tablet = await service.issue(userId, { name: 'tablet' });

    await service.revoke(phone.refreshToken);

    expect(rows[0]!.revokedAt).toBeInstanceOf(Date);
    expect(rows[1]!.revokedAt).toBeNull();
    await expectUnauthorized(service.rotate(phone.refreshToken));
    await expect(service.rotate(tablet.refreshToken)).resolves.toHaveProperty('refreshToken');
  });

  it('이미 폐기됐거나 없는 토큰이어도 오류 없이 끝난다', async () => {
    const { service } = setup();
    const { refreshToken } = await service.issue(newUserId());
    await service.revoke(refreshToken);

    await expect(service.revoke(refreshToken)).resolves.toBeUndefined();
    await expect(service.revoke('아무-토큰')).resolves.toBeUndefined();
  });
});
