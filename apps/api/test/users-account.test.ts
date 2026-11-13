import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

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
let me: Types.ObjectId;
const other = new Types.ObjectId();

beforeEach(() => {
  me = new Types.ObjectId();
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
    tokens as never,
    friendships as never,
    shares as never,
  );
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
      deletedAt: NOW,
      email: null,
      passwordHash: null,
      socialAccounts: [],
      nickname: `탈퇴-${me.toHexString()}`,
      status: 'offline',
    });
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
});
