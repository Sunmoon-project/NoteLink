import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UsersService } from '../src/modules/users/users.service.js';
import { matches, type Row } from './support/fake-collection.js';

/** 서비스가 쓰는 연산만 갖춘 메모리 모델($set · upsert · updateMany · deleteMany) */
function model(rows: Row[]) {
  return {
    rows,
    exists: (f: Record<string, unknown>) =>
      Promise.resolve(rows.some((r) => matches(r, f)) ? { _id: new Types.ObjectId() } : null),
    findOne: (f: Record<string, unknown>) =>
      Promise.resolve(rows.find((r) => matches(r, f)) ?? null),
    updateOne: (
      f: Record<string, unknown>,
      u: { $set: Record<string, unknown> },
      o?: { upsert?: boolean },
    ) => {
      const row = rows.find((r) => matches(r, f));
      if (row) Object.assign(row, u.$set);
      else if (o?.upsert) rows.push({ _id: new Types.ObjectId(), ...f, ...u.$set });
      return Promise.resolve({ matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 });
    },
    updateMany: (f: Record<string, unknown>, u: Record<string, unknown>) => {
      const hit = rows.filter((r) => matches(r, f));
      for (const r of hit) Object.assign(r, u);
      return Promise.resolve({ modifiedCount: hit.length });
    },
    distinct: (key: string, f: Record<string, unknown> = {}) =>
      Promise.resolve([
        ...new Map(
          rows.filter((r) => matches(r, f)).map((r) => [String(r[key]), r[key]] as const),
        ).values(),
      ]),
    deleteMany: (f: Record<string, unknown>) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, f)) rows.splice(i, 1);
      return Promise.resolve({ deletedCount: before - rows.length });
    },
  };
}

const NOW = new Date('2026-11-13T00:00:00Z');
let users: ReturnType<typeof model>;
let devices: ReturnType<typeof model>;
let tokens: ReturnType<typeof model>;
let friendships: ReturnType<typeof model>;
let shares: ReturnType<typeof model>;
let service: UsersService;
let revokedUsers: Types.ObjectId[];
let me: Types.ObjectId;
const other = new Types.ObjectId();

beforeEach(() => {
  me = new Types.ObjectId();
  revokedUsers = [];
  users = model([
    {
      _id: me,
      email: 'me@example.com',
      passwordHash: 'hash',
      nickname: '나',
      status: 'active',
      socialAccounts: [{ provider: 'google', providerUid: 'g1' }],
      deletedAt: null,
      createdAt: NOW,
    },
  ]);
  devices = model([]);
  tokens = model([
    { _id: new Types.ObjectId(), userId: me, revokedAt: null },
    { _id: new Types.ObjectId(), userId: other, revokedAt: null },
  ]);
  friendships = model([
    { _id: new Types.ObjectId(), userA: me, userB: other, status: 'accepted' },
    { _id: new Types.ObjectId(), userA: other, userB: new Types.ObjectId(), status: 'accepted' },
  ]);
  shares = model([
    { _id: new Types.ObjectId(), ownerId: me, friendId: other },
    { _id: new Types.ObjectId(), ownerId: other, friendId: me },
  ]);
  service = new UsersService(
    users as never,
    { streakDays: async () => 0 } as never,
    devices as never,
    // TokenService.revokeAll만 쓴다(access 토큰 거절은 token.service.test.ts에서 본다)
    {
      revokeAll: (userId: Types.ObjectId, now: Date) => {
        revokedUsers.push(userId);
        return tokens.updateMany({ userId, revokedAt: null }, { revokedAt: now });
      },
    } as never,
    friendships as never,
    shares as never,
  );
});

/** 기기 저장(upsert)이 몇 번 불렸는지 센다 */
function savedDevices() {
  const updateOne = devices.updateOne;
  let count = 0;
  devices.updateOne = (...args) => {
    count += 1;
    return updateOne(...args);
  };
  return () => count;
}

afterEach(() => {
  service.onModuleDestroy();
  vi.useRealTimers();
});

describe('상태 · 기기', () => {
  it('내 상태를 바꾼다', async () => {
    await service.setStatus(me.toHexString(), { status: 'busy' });
    expect(users.rows[0]!.status).toBe('busy');
  });

  it('기기를 등록하고, 같은 토큰을 다른 계정이 등록하면 그 계정으로 옮긴다', async () => {
    const token = 'ExponentPushToken[abc123]';
    await service.registerDevice(
      me.toHexString(),
      { platform: 'ios', pushToken: token, locale: 'ko-KR' },
      NOW,
    );
    await service.registerDevice(
      me.toHexString(),
      { platform: 'ios', pushToken: token, locale: 'en-US' },
      NOW,
    );
    expect(devices.rows).toHaveLength(1);
    expect(devices.rows[0]).toMatchObject({ locale: 'en-US', lastSeenAt: NOW });
    users.rows.push({ _id: other, nickname: '남', deletedAt: null });
    await service.registerDevice(
      other.toHexString(),
      { platform: 'ios', pushToken: token, locale: 'ko-KR' },
      NOW,
    );
    expect(devices.rows).toHaveLength(1);
    expect(String(devices.rows[0]!.userId)).toBe(String(other));
  });

  it('탈퇴를 시작한 계정은 기기를 받지 않는다', async () => {
    users.rows[0]!.withdrawingAt = NOW;
    await expect(
      service.registerDevice(me.toHexString(), {
        platform: 'ios',
        pushToken: 't',
        locale: 'ko-KR',
      }),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(devices.rows).toHaveLength(0);
  });

  it('확인 직후 탈퇴가 끝까지 돌고 나서 저장돼도 기기가 남지 않는다', async () => {
    const saved = savedDevices();
    const exists = users.exists;
    let calls = 0;
    users.exists = async (f) => {
      calls += 1;
      const found = await exists(f);
      // 기기 등록의 첫 확인이 통과한 직후 탈퇴가 처음부터 끝까지 돈다(그 안의 확인은 그대로 통과)
      if (calls === 1) {
        users.exists = exists;
        await service.withdraw(me.toHexString(), NOW);
      }
      return found;
    };
    await expect(
      service.registerDevice(me.toHexString(), {
        platform: 'ios',
        pushToken: 't',
        locale: 'ko-KR',
      }),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(users.rows[0]).toMatchObject({ deletedAt: NOW });
    expect(saved()).toBe(1); // 저장까지 갔고, 보상 삭제가 지웠다
    expect(devices.rows).toHaveLength(0);
  });

  it('보상 삭제까지 실패하면 서버가 도는 중에도 정리될 때까지 다시 한다(간격을 늘려 가며)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const deleteMany = devices.deleteMany;
    const exists = users.exists;
    let calls = 0;
    users.exists = async (f) => {
      calls += 1;
      const found = await exists(f);
      if (calls === 1) {
        users.exists = exists;
        await service.withdraw(me.toHexString(), NOW);
        devices.deleteMany = () => Promise.reject(new Error('DB 오류'));
      }
      return found;
    };
    await expect(
      service.registerDevice(me.toHexString(), {
        platform: 'ios',
        pushToken: 't',
        locale: 'ko-KR',
      }),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(devices.rows).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000); // 1분 뒤 정리: DB가 아직 안 돼서 실패 → 2분 뒤로
    expect(devices.rows).toHaveLength(1);
    devices.deleteMany = deleteMany; // DB가 돌아왔다
    await vi.advanceTimersByTimeAsync(60_000); // 아직 2분이 안 됐다
    expect(devices.rows).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(devices.rows).toHaveLength(0);
  });

  it('저장 뒤 다시 확인하다 DB 오류가 나도, 그사이 탈퇴했다면 잡아 둔 정리가 기기를 지운다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const original = users.exists;
    // 기기 등록의 첫 확인이 통과한 직후 탈퇴가 끝까지 돌고(그 안의 확인은 원래 함수), 저장 뒤 다시 확인은 DB 오류
    users.exists = async (f) => {
      const found = await original(f);
      users.exists = original;
      await service.withdraw(me.toHexString(), NOW);
      users.exists = () => Promise.reject(new Error('DB 오류'));
      return found;
    };
    await expect(
      service.registerDevice(me.toHexString(), {
        platform: 'ios',
        pushToken: 't',
        locale: 'ko-KR',
      }),
    ).rejects.toThrow('DB 오류');
    expect(devices.rows).toHaveLength(1);
    users.exists = original;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(devices.rows).toHaveLength(0);
  });

  it('보상 삭제까지 실패해 남은 기기는 서버가 켜질 때의 정리가 지운다', async () => {
    const exists = users.exists;
    let calls = 0;
    users.exists = async (f) => {
      calls += 1;
      const found = await exists(f);
      if (calls === 1) {
        users.exists = exists;
        await service.withdraw(me.toHexString(), NOW);
        devices.deleteMany = () => Promise.reject(new Error('DB 오류')); // 이후 기기 삭제는 모두 실패
      }
      return found;
    };
    await expect(
      service.registerDevice(me.toHexString(), {
        platform: 'ios',
        pushToken: 't',
        locale: 'ko-KR',
      }),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(devices.rows).toHaveLength(1);

    devices.deleteMany = model(devices.rows).deleteMany; // DB가 돌아온 뒤 서버 재시작
    devices.rows.push({
      _id: new Types.ObjectId(),
      userId: other,
      pushToken: 'o',
      platform: 'ios',
    });
    expect(await service.sweepWithdrawnDevices()).toBe(1);
    expect(devices.rows.map((d) => d.pushToken)).toEqual(['o']); // 탈퇴하지 않은 사람의 기기는 남는다
  });

  it('등록하는 사이에 탈퇴했으면 저장한 기기를 지우고 404', async () => {
    // 확인(exists)은 통과하고, 저장한 뒤 다시 확인할 때는 탈퇴한 상태
    const saved = savedDevices();
    const exists = users.exists;
    let calls = 0;
    users.exists = (f) => (++calls === 1 ? exists(f) : Promise.resolve(null));
    await expect(
      service.registerDevice(
        me.toHexString(),
        { platform: 'ios', pushToken: 't', locale: 'ko-KR' },
        NOW,
      ),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
    expect(saved()).toBe(1);
    expect(devices.rows).toHaveLength(0);
  });

  it('탈퇴했거나 없는 사용자는 404', async () => {
    await expect(
      service.setStatus(new Types.ObjectId().toHexString(), { status: 'busy' }),
    ).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
    await expect(service.setStatus('bad-id', { status: 'busy' })).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
  });
});

describe('요금제', () => {
  it('결제 연동 전에는 유료 요금제로 올릴 수 없다(402)', async () => {
    await expect(service.changePlan(me.toHexString(), { tier: 'pro' })).rejects.toMatchObject({
      status: 402,
      response: { code: 'PAYMENT_REQUIRED' },
    });
    expect(users.rows[0]!.subscription).toBeUndefined();
  });

  it('무료로 내리면 기록하고, 바뀐 내 정보에 요금제가 담긴다', async () => {
    const user = await service.changePlan(me.toHexString(), { tier: 'free' }, NOW);
    expect(users.rows[0]!.subscription).toMatchObject({ tier: 'free', autoRenew: false });
    expect(user.subscription).toMatchObject({ tier: 'free', status: 'active' });
  });
});

describe('회원 탈퇴', () => {
  it('로그인 수단 · 개인 정보를 지우고, 내 토큰 · 기기 · 친구 · 시간표 공유만 정리한다', async () => {
    devices.rows.push({ _id: new Types.ObjectId(), userId: me, pushToken: 't', platform: 'ios' });
    await service.withdraw(me.toHexString(), NOW);
    expect(users.rows[0]).toMatchObject({
      withdrawingAt: NOW,
      deletedAt: NOW,
      email: null,
      passwordHash: null,
      socialAccounts: [],
      nickname: `탈퇴-${me.toHexString()}`,
      status: 'offline',
    });
    expect(revokedUsers.map(String)).toEqual([String(me)]);
    expect(tokens.rows.find((t) => String(t.userId) === String(me))!.revokedAt).toEqual(NOW);
    expect(tokens.rows.find((t) => String(t.userId) === String(other))!.revokedAt).toBeNull();
    expect(devices.rows).toHaveLength(0);
    expect(friendships.rows).toHaveLength(1); // 남끼리의 친구 관계는 남는다
    expect(shares.rows).toHaveLength(0);
    // 다시 탈퇴하면 404(이미 탈퇴함)
    await expect(service.withdraw(me.toHexString())).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
  });

  it('정리 중에 실패하면 계정은 탈퇴 전 그대로라 다시 시도해 끝낼 수 있다', async () => {
    const deleteMany = friendships.deleteMany;
    friendships.deleteMany = () => Promise.reject(new Error('DB 오류'));
    await expect(service.withdraw(me.toHexString(), NOW)).rejects.toThrow('DB 오류');
    expect(users.rows[0]).toMatchObject({ deletedAt: null, email: 'me@example.com' });

    friendships.deleteMany = deleteMany;
    await service.withdraw(me.toHexString(), NOW);
    expect(users.rows[0]).toMatchObject({ deletedAt: NOW, email: null });
    expect(friendships.rows).toHaveLength(1);
    expect(shares.rows).toHaveLength(0);
  });
});
