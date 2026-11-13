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
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  device?: Record<string, unknown>;
  expiresAt: Date;
  revokedAt: Date | null;
  claimId?: string | null;
}

type Filter = {
  tokenHash: string;
  revokedAt?: null;
  expiresAt?: { $gt: Date };
  claimId?: string;
};
type Update = { revokedAt: Date | null; claimId?: string | null };

/**
 * refresh_tokens 컬렉션을 메모리로 흉내 낸다. TokenService가 쓰는 것(create · findOne · findOneAndUpdate · updateOne · deleteOne)만 만든다.
 * findOneAndUpdate는 실제 Mongoose처럼 "바뀌기 전" 문서를 돌려주고, 찾기와 고치기를 한 번에 한다.
 * `failures`로 다음 저장(create) 또는 정리(deleteOne)를 실패시킬 수 있다.
 * `hooks.afterCreate`는 문서가 저장된 직후 한 번 호출된다(저장하는 사이에 시간이 흐르는 상황을 만들 때 쓴다).
 */
function createFakeModel() {
  const rows: Row[] = [];
  const failures = { create: 0, deleteOne: 0 };
  const hooks: { afterCreate?: () => void } = {};
  // 서비스가 넘긴 조건만 그대로 적용한다. 조건이 빠지면 그만큼 더 많이 걸려서 테스트가 잡아낸다
  const matches = (row: Row, f: Filter) =>
    row.tokenHash === f.tokenHash &&
    (!('revokedAt' in f) || row.revokedAt === f.revokedAt) &&
    (!f.expiresAt || row.expiresAt > f.expiresAt.$gt) &&
    (!('claimId' in f) || row.claimId === f.claimId);

  const model = {
    create: (data: Omit<Row, 'revokedAt' | '_id'>) => {
      if (failures.create > 0) {
        failures.create -= 1;
        return Promise.reject(new Error('DB 쓰기 실패'));
      }
      if (rows.some((r) => r.tokenHash === data.tokenHash)) {
        return Promise.reject(new Error('E11000 duplicate key (tokenHash)'));
      }
      const row: Row = { ...data, _id: new Types.ObjectId(), revokedAt: null };
      rows.push(row);
      const afterCreate = hooks.afterCreate;
      hooks.afterCreate = undefined;
      afterCreate?.();
      return Promise.resolve(row);
    },
    findOne: (filter: Filter) => Promise.resolve(rows.find((r) => matches(r, filter)) ?? null),
    findOneAndUpdate: (filter: Filter, update: Update) => {
      const row = rows.find((r) => matches(r, filter));
      if (!row) return Promise.resolve(null);
      const before = { ...row };
      Object.assign(row, update);
      return Promise.resolve(before);
    },
    updateOne: (filter: Filter, update: Update) => {
      const row = rows.find((r) => matches(r, filter));
      if (row) Object.assign(row, update);
      return Promise.resolve({ modifiedCount: row ? 1 : 0 });
    },
    updateMany: (filter: { userId: Types.ObjectId; revokedAt?: null }, update: Update) => {
      const hit = rows.filter(
        (r) => r.userId.equals(filter.userId) && (!('revokedAt' in filter) || r.revokedAt === null),
      );
      for (const r of hit) Object.assign(r, update);
      return Promise.resolve({ modifiedCount: hit.length });
    },
    deleteOne: (filter: { _id: Types.ObjectId }) => {
      if (failures.deleteOne > 0) {
        failures.deleteOne -= 1;
        return Promise.reject(new Error('DB 삭제 실패'));
      }
      const i = rows.findIndex((r) => r._id.equals(filter._id));
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({ deletedCount: i >= 0 ? 1 : 0 });
    },
  };
  return { rows, failures, hooks, model: model as unknown as Model<RefreshTokenDocument> };
}

/** users 컬렉션: 탈퇴 · 로그인 끊은 시각만 담는다. 없는 id는 활성 사용자로 본다(지우려면 deleted에 넣는다) */
function createFakeUsers() {
  const state = new Map<
    string,
    {
      deletedAt?: Date | null;
      sessionsRevokedAt?: Date | null;
      passwordHash?: string | null;
      sessionVersion?: number;
    }
  >();
  const missing = new Set<string>();
  // 다음 findOne 몇 번을 DB 오류로 실패시킨다(skip번은 통과시킨 뒤)
  const failures = { skip: 0, findOne: 0 };
  const model = {
    findOne: (filter: { _id: Types.ObjectId }) => ({
      lean: () => {
        if (failures.findOne > 0) {
          if (failures.skip > 0) failures.skip -= 1;
          else {
            failures.findOne -= 1;
            return Promise.reject(new Error('DB 읽기 실패'));
          }
        }
        const id = filter._id.toHexString();
        return Promise.resolve(missing.has(id) ? null : (state.get(id) ?? {}));
      },
    }),
    updateOne: (
      filter: { _id: Types.ObjectId },
      update: { $set: { sessionsRevokedAt: Date }; $inc?: { sessionVersion: number } },
    ) => {
      const id = filter._id.toHexString();
      const prev = state.get(id);
      state.set(id, {
        ...prev,
        ...update.$set,
        sessionVersion: (prev?.sessionVersion ?? 0) + (update.$inc?.sessionVersion ?? 0),
      });
      return Promise.resolve({ matchedCount: 1 });
    },
  };
  return { state, missing, failures, model: model as never };
}

function setup() {
  const fake = createFakeModel();
  const users = createFakeUsers();
  const jwt = new JwtService();
  const service = new TokenService(jwt, CONFIG, fake.model, users.model);
  return { service, jwt, rows: fake.rows, failures: fake.failures, hooks: fake.hooks, users };
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

  it('새 토큰을 저장하지 못하면 갱신은 실패하지만 기존 토큰은 그대로 쓸 수 있다', async () => {
    const { service, rows, failures } = setup();
    const first = await service.issue(newUserId());
    failures.create = 1; // 다음 저장 한 번을 실패시킨다

    await expect(service.rotate(first.refreshToken)).rejects.toThrow('DB 쓰기 실패');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull(); // 기존 토큰이 폐기되지 않았다
    await expect(service.rotate(first.refreshToken)).resolves.toHaveProperty('refreshToken'); // 다시 시도하면 된다
  });

  it('동시 요청에 져서 버려지는 새 토큰의 줄은 지운다', async () => {
    const { service, rows } = setup();
    const first = await service.issue(newUserId());

    await Promise.allSettled([
      service.rotate(first.refreshToken),
      service.rotate(first.refreshToken),
    ]);

    // 처음 토큰 1줄 + 이긴 쪽의 새 토큰 1줄. 진 쪽의 새 토큰 줄은 남지 않는다
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });

  it('동시 요청에 졌을 때 정리(삭제)가 실패해도 요청은 거부로 끝난다', async () => {
    const { service, failures } = setup();
    const first = await service.issue(newUserId());
    failures.deleteOne = 1;

    const results = await Promise.allSettled([
      service.rotate(first.refreshToken),
      service.rotate(first.refreshToken),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost).toMatchObject({ reason: { response: { code: 'AUTH_TOKEN_EXPIRED' } } });
  });

  it('새 토큰을 만드는 사이에 기존 토큰이 만료되면 거부하고 새로 만든 줄을 지운다', async () => {
    const { service, rows, hooks } = setup();
    const first = await service.issue(newUserId());
    // 새 토큰이 저장되는 순간 기존 토큰의 만료 시각이 지난 것으로 만든다
    hooks.afterCreate = () => {
      rows[0]!.expiresAt = new Date(Date.now() - 1000);
    };

    await expectUnauthorized(service.rotate(first.refreshToken));

    expect(rows).toHaveLength(1); // 새로 만든 줄이 남지 않았다
    expect(rows[0]!.revokedAt).toBeNull(); // 만료된 토큰을 폐기 처리하며 성공시키지도 않았다
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

describe('로그인 끊기 · 탈퇴', () => {
  afterEach(() => vi.useRealTimers());

  it('로그인을 확인한 뒤 발급 전에 로그인이 끊겼으면(비밀번호 재설정) 토큰을 지우고 거절한다', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00.000Z') });
    const { service, rows } = setup();
    const userId = newUserId();
    const authorizedAt = new Date(); // 예전 비밀번호를 읽은 시각
    vi.setSystemTime(new Date('2026-11-13T00:00:00.200Z'));
    await service.revokeAll(new Types.ObjectId(userId)); // 그사이 재설정
    vi.setSystemTime(new Date('2026-11-13T00:00:00.400Z'));

    await expectUnauthorized(service.issue(userId, undefined, authorizedAt));
    expect(rows).toHaveLength(0);
    // 끊기 뒤에 확인한 로그인은 된다
    await expect(service.issue(userId, undefined, new Date())).resolves.toBeDefined();
  });

  it('갱신의 두 번째 확인에서 DB를 못 읽으면 401이 아니라 오류를 내고, 쓴 토큰을 되살려 다시 갱신할 수 있다', async () => {
    const { service, rows, users } = setup();
    const pair = await service.issue(newUserId());
    users.failures.skip = 1; // 첫 확인은 통과, 두 번째 확인만 실패
    users.failures.findOne = 1;

    await expect(service.rotate(pair.refreshToken)).rejects.toThrow('DB 읽기 실패');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
    await expect(service.rotate(pair.refreshToken)).resolves.toBeDefined();
  });

  it('갱신 도중 DB 오류가 난 사이에 로그아웃했으면(같은 밀리초여도) 쓴 토큰을 되살리지 않는다', async () => {
    // 시계를 멈춰 갱신의 폐기 시각과 로그아웃 시각이 같은 밀리초가 되게 한다
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00.000Z') });
    const { service, rows, users } = setup();
    const pair = await service.issue(newUserId());
    const model = users.model as unknown as {
      findOne: (f: unknown) => { lean: () => Promise<unknown> };
    };
    const findOne = model.findOne;
    let calls = 0;
    model.findOne = (f) => ({
      lean: async () => {
        calls += 1;
        if (calls === 1) return findOne(f).lean();
        await service.revoke(pair.refreshToken); // 두 번째 확인 중에 로그아웃
        throw new Error('DB 읽기 실패');
      },
    });

    await expect(service.rotate(pair.refreshToken)).rejects.toThrow('DB 읽기 실패');
    expect(rows[0]!.revokedAt).not.toBeNull();
    model.findOne = findOne;
    await expectUnauthorized(service.rotate(pair.refreshToken));
  });

  it('로그인이 확인한 비밀번호 해시가 발급 때 DB와 다르면(그사이 재설정) 끊은 시각과 상관없이 거절한다', async () => {
    const { service, rows, users } = setup();
    const userId = newUserId();
    users.state.set(userId, { passwordHash: 'new-hash' });

    await expectUnauthorized(service.issue(userId, undefined, new Date(), 'old-hash'));
    expect(rows).toHaveLength(0);
    await expect(service.issue(userId, undefined, new Date(), 'new-hash')).resolves.toBeDefined();
  });

  it('revokeAll은 세션 버전을 올려, 끊은 시각보다 늦게 만든 예전 버전 토큰도 거절한다', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:01.000Z') });
    const { service } = setup();
    const userId = newUserId();
    const pair = await service.issue(userId); // 버전 0
    // 끊은 시각이 토큰보다 앞서는 경우(시각을 정한 뒤 DB 반영 전에 토큰이 만들어짐)
    await service.revokeAll(new Types.ObjectId(userId), new Date('2026-11-13T00:00:00.000Z'));

    await expectUnauthorized(service.verifyAccess(pair.accessToken));
    await expectUnauthorized(service.rotate(pair.refreshToken));
    // 새로 로그인하면 지금 버전(1)으로 받아 쓸 수 있다
    vi.setSystemTime(new Date('2026-11-13T00:00:02.000Z'));
    const next = await service.issue(userId);
    await expect(service.verifyAccess(next.accessToken)).resolves.toEqual({ userId });
    await expect(service.rotate(next.refreshToken)).resolves.toBeDefined();
  });

  it('같은 밀리초에 받은 토큰도 거절한다', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00.000Z') });
    const { service } = setup();
    const userId = newUserId();
    const pair = await service.issue(userId);
    await service.revokeAll(new Types.ObjectId(userId));

    await expectUnauthorized(service.verifyAccess(pair.accessToken));
  });

  it('갱신 도중(확인 뒤 · 새 토큰 저장 전) 로그인이 끊기면 새 토큰을 주지 않고 지운다', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00.000Z') });
    const { service, rows, hooks, users } = setup();
    const userId = newUserId();
    const pair = await service.issue(userId);
    vi.setSystemTime(new Date('2026-11-13T00:00:01.000Z'));
    // 새 토큰 줄이 저장된 직후, 기존 줄을 폐기하기 전에 끊긴 시각만 먼저 적힌 상황
    hooks.afterCreate = () => {
      users.state.set(userId, { sessionsRevokedAt: new Date('2026-11-13T00:00:00.500Z') });
    };

    await expectUnauthorized(service.rotate(pair.refreshToken));
    expect(rows).toHaveLength(1);
  });

  it('revokeAll 뒤에는 그 전에 받은 access · refresh 토큰을 모두 거절한다', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00Z') });
    const { service, rows } = setup();
    const userId = newUserId();
    const pair = await service.issue(userId);

    vi.setSystemTime(new Date('2026-11-13T00:00:05Z'));
    await service.revokeAll(new Types.ObjectId(userId));

    await expectUnauthorized(service.verifyAccess(pair.accessToken));
    await expectUnauthorized(service.rotate(pair.refreshToken));
    expect(rows.every((r) => r.revokedAt)).toBe(true);
  });

  it('끊기 직전 같은 초에 받은 토큰도 거절한다(밀리초로 비교)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00.100Z') });
    const { service } = setup();
    const userId = newUserId();
    const pair = await service.issue(userId);

    vi.setSystemTime(new Date('2026-11-13T00:00:00.900Z'));
    await service.revokeAll(new Types.ObjectId(userId));

    await expectUnauthorized(service.verifyAccess(pair.accessToken));
    await expectUnauthorized(service.rotate(pair.refreshToken));
  });

  it('밀리초 발급 시각이 없는 예전 토큰은 끊은 그 초에 받았어도 거절한다', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00.500Z') });
    const { service, jwt } = setup();
    const userId = newUserId();
    const legacy = jwt.sign({ sub: userId }, { secret: CONFIG.accessSecret, expiresIn: '15m' });
    await service.revokeAll(new Types.ObjectId(userId));

    await expectUnauthorized(service.verifyAccess(legacy));
  });

  it('끊은 뒤 새로 로그인한 토큰은 받는다(같은 초여도)', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T00:00:00.000Z') });
    const { service } = setup();
    const userId = newUserId();
    await service.revokeAll(new Types.ObjectId(userId));
    vi.setSystemTime(new Date('2026-11-13T00:00:00.001Z'));

    const pair = await service.issue(userId);
    await expect(service.verifyAccess(pair.accessToken)).resolves.toEqual({ userId });
  });

  it('탈퇴했거나 없는 사용자의 토큰은 거절한다', async () => {
    const { service, users } = setup();
    const gone = newUserId();
    const missing = newUserId();
    const a = await service.issue(gone);
    const b = await service.issue(missing);
    users.state.set(gone, { deletedAt: new Date() });
    users.missing.add(missing);

    await expectUnauthorized(service.verifyAccess(a.accessToken));
    await expectUnauthorized(service.rotate(a.refreshToken));
    await expectUnauthorized(service.verifyAccess(b.accessToken));
  });
});
