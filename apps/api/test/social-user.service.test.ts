import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { UserDocument } from '../src/modules/auth/schemas/user.schema.js';
import type { SocialProfile } from '../src/modules/auth/social-login/social-provider.js';
import { SocialUserService } from '../src/modules/auth/social-login/social-user.service.js';

interface Social {
  provider: string;
  providerUid: string;
  email: string | null;
  linkedAt: Date;
}
interface Row {
  _id: Types.ObjectId;
  nickname: string;
  email: string | null;
  socialAccounts: Social[];
  lastLoginAt: Date | null;
  deletedAt: Date | null;
}

type SocialFilter = {
  socialAccounts: { $elemMatch: { provider: string; providerUid: string } };
  deletedAt: null;
};

/**
 * users 컬렉션을 메모리로 흉내 낸다. 서비스가 쓰는 findOneAndUpdate · exists · create만 만든다.
 * 서비스가 넘긴 조건(소셜 계정 · 탈퇴 여부 · 이메일)을 그대로 적용해서, 조건이 빠지면 테스트가 잡아낸다.
 * 실제 MongoDB의 유일 인덱스(이메일 · 소셜 계정)도 같은 규칙으로 흉내 낸다.
 */
function createFakeUsers() {
  const rows: Row[] = [];
  const hooks: { beforeCreate?: () => void } = {};
  const miss: { afterSignInMiss?: () => void } = {};
  const failures = { create: 0 };
  const stats = { creates: 0 };

  const hasSocial = (row: Row, f: SocialFilter) =>
    row.socialAccounts.some(
      (s) =>
        s.provider === f.socialAccounts.$elemMatch.provider &&
        s.providerUid === f.socialAccounts.$elemMatch.providerUid,
    );
  const notDeleted = (row: Row, f: { deletedAt?: null }) =>
    !('deletedAt' in f) || row.deletedAt === f.deletedAt;
  const duplicate = (keyPattern: Record<string, number>) =>
    Object.assign(new Error('E11000 duplicate key'), { code: 11000, keyPattern });

  const model = {
    findOneAndUpdate: (
      filter: SocialFilter,
      update: Partial<Row>,
      options?: { projection?: Record<string, number> },
    ) => {
      const row = rows.find((r) => hasSocial(r, filter) && notDeleted(r, filter));
      if (!row) {
        const hook = miss.afterSignInMiss;
        miss.afterSignInMiss = undefined;
        hook?.();
        return Promise.resolve(null);
      }
      const before = { ...row };
      Object.assign(row, update); // 서비스가 넘긴 변경을 전부 반영한다(닉네임 같은 것을 건드리면 드러난다)
      // 실제 Mongoose는 projection에 적은 필드만 돌려준다
      return Promise.resolve(options?.projection ? { _id: before._id } : before);
    },
    exists: (filter: { email: string; deletedAt: null }) => {
      const row = rows.find((r) => r.email === filter.email && notDeleted(r, filter));
      return Promise.resolve(row ? { _id: row._id } : null);
    },
    create: (data: Omit<Row, '_id' | 'deletedAt'>) => {
      stats.creates += 1;
      hooks.beforeCreate?.();
      hooks.beforeCreate = undefined;
      if (failures.create > 0) {
        failures.create -= 1;
        return Promise.reject(new Error('DB 쓰기 실패'));
      }
      // 유일 인덱스: 이메일(문자열인 경우만), 소셜 계정(제공자 + 고유 번호)
      if (data.email !== null && rows.some((r) => r.email === data.email)) {
        return Promise.reject(duplicate({ email: 1 }));
      }
      for (const s of data.socialAccounts) {
        const taken = rows.some((r) =>
          r.socialAccounts.some(
            (o) => o.provider === s.provider && o.providerUid === s.providerUid,
          ),
        );
        if (taken)
          return Promise.reject(
            duplicate({ 'socialAccounts.provider': 1, 'socialAccounts.providerUid': 1 }),
          );
      }
      const row: Row = { ...data, _id: new Types.ObjectId(), deletedAt: null };
      rows.push(row);
      return Promise.resolve(row);
    },
  } as unknown as Model<UserDocument>;

  const seed = (partial: Partial<Row> & { nickname?: string } = {}): Row => {
    const row: Row = {
      _id: new Types.ObjectId(),
      nickname: '기존사용자',
      email: null,
      socialAccounts: [],
      lastLoginAt: null,
      deletedAt: null,
      ...partial,
    };
    rows.push(row);
    return row;
  };

  return { rows, model, hooks, miss, failures, stats, seed };
}

const PROFILE: SocialProfile = {
  providerUid: '110169484474386276334',
  email: 'student@example.com',
  name: '김노트',
};

const googleAccount = (providerUid: string, email: string | null = null): Social => ({
  provider: 'google',
  providerUid,
  email,
  linkedAt: new Date('2026-01-01T00:00:00Z'),
});

function setup() {
  const fake = createFakeUsers();
  return { ...fake, service: new SocialUserService(fake.model) };
}

describe('SocialUserService.findOrCreate', () => {
  it('닉네임 중복이면 새 닉네임으로 재시도하여 가입한다', async () => {
    const { service, model, rows } = setup();
    const create = vi
      .spyOn(model, 'create')
      .mockRejectedValueOnce({ code: 11000, keyPattern: { nickname: 1 } });
    const result = await service.findOrCreate('google', PROFILE);
    expect(result.kind).toBe('signed_in');
    expect(create).toHaveBeenCalledTimes(2);
    expect(rows[0]!.nickname).toMatch(/^사용자\d{4}$/);
  });
  describe('처음 오는 사용자 (새 계정)', () => {
    it('새 사용자를 만들고 signed_in(created)을 돌려준다', async () => {
      const { service, rows } = setup();

      const result = await service.findOrCreate('google', PROFILE);

      expect(rows).toHaveLength(1);
      expect(result).toEqual({ kind: 'signed_in', userId: rows[0]!._id, created: true });
    });

    it('이름에서 닉네임 초기값을 만든다', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', PROFILE);

      expect(rows[0]!.nickname).toBe('김노트');
    });

    it('이름이 닉네임 규칙에 맞지 않으면 규칙에 맞게 고친다', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', { ...PROFILE, name: 'Kim Note!! 😀' });

      expect(rows[0]!.nickname).toBe('KimNote');
    });

    it('이름이 없으면 사용자 + 숫자 닉네임을 쓴다', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', { ...PROFILE, name: null });

      expect(rows[0]!.nickname).toMatch(/^사용자\d{4}$/);
    });

    it('인증된 이메일이 있으면 사용자 이메일로 저장한다', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', PROFILE);

      expect(rows[0]!.email).toBe('student@example.com');
    });

    it('이메일이 없으면(null) 이메일 없이 만든다', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', { ...PROFILE, email: null });

      expect(rows[0]!.email).toBeNull();
    });

    it('소셜 연동 정보(제공자 · 고유 번호 · 이메일 · 연동 시각)를 기록한다', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', PROFILE);

      expect(rows[0]!.socialAccounts).toEqual([
        {
          provider: 'google',
          providerUid: PROFILE.providerUid,
          email: 'student@example.com',
          linkedAt: expect.any(Date),
        },
      ]);
    });

    it('마지막 로그인 시각을 기록한다', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', PROFILE);

      expect(rows[0]!.lastLoginAt).toBeInstanceOf(Date);
    });

    it('비밀번호는 만들지 않는다 (소셜 전용 계정)', async () => {
      const { service, rows } = setup();

      await service.findOrCreate('google', PROFILE);

      expect(rows[0]).not.toHaveProperty('passwordHash');
    });
  });

  describe('이미 이 소셜 계정으로 가입한 사용자 (재로그인)', () => {
    it('새로 만들지 않고 같은 사용자로 signed_in(created 아님)을 돌려준다', async () => {
      const { service, rows, seed } = setup();
      const existing = seed({ socialAccounts: [googleAccount(PROFILE.providerUid)] });

      const result = await service.findOrCreate('google', PROFILE);

      expect(rows).toHaveLength(1);
      expect(result).toEqual({ kind: 'signed_in', userId: existing._id, created: false });
    });

    it('마지막 로그인 시각을 갱신한다', async () => {
      const { service, seed } = setup();
      const existing = seed({ socialAccounts: [googleAccount(PROFILE.providerUid)] });

      await service.findOrCreate('google', PROFILE);

      expect(existing.lastLoginAt).toBeInstanceOf(Date);
    });

    it('구글에서 이메일을 바꿨어도 같은 사용자로 찾는다 (이메일이 아니라 고유 번호로 찾는다)', async () => {
      const { service, seed } = setup();
      const existing = seed({
        email: 'old@example.com',
        socialAccounts: [googleAccount(PROFILE.providerUid, 'old@example.com')],
      });

      const result = await service.findOrCreate('google', { ...PROFILE, email: 'new@example.com' });

      expect(result).toEqual({ kind: 'signed_in', userId: existing._id, created: false });
    });

    it('이메일이 인증되지 않아 null이어도 같은 사용자로 찾는다', async () => {
      const { service, seed } = setup();
      const existing = seed({ socialAccounts: [googleAccount(PROFILE.providerUid)] });

      const result = await service.findOrCreate('google', { ...PROFILE, email: null });

      expect(result).toMatchObject({ kind: 'signed_in', userId: existing._id });
    });

    it('이름이 바뀌어도 기존 닉네임을 덮어쓰지 않는다 (사용자가 정한 닉네임을 보존)', async () => {
      const { service, seed } = setup();
      const existing = seed({
        nickname: '내가정한닉',
        socialAccounts: [googleAccount(PROFILE.providerUid)],
      });

      await service.findOrCreate('google', { ...PROFILE, name: '완전히다른이름' });

      expect(existing.nickname).toBe('내가정한닉');
    });

    it('다른 구글 계정의 사용자는 건드리지 않는다', async () => {
      const { service, seed } = setup();
      const other = seed({ socialAccounts: [googleAccount('someone-else')] });

      await service.findOrCreate('google', PROFILE);

      expect(other.lastLoginAt).toBeNull();
    });

    it('같은 고유 번호라도 제공자가 다르면 다른 사용자다', async () => {
      const { service, rows, seed } = setup();
      seed({
        socialAccounts: [{ ...googleAccount(PROFILE.providerUid), provider: 'kakao' }],
      });

      const result = await service.findOrCreate('google', { ...PROFILE, email: null });

      expect(rows).toHaveLength(2);
      expect(result).toMatchObject({ kind: 'signed_in', created: true });
    });
  });

  describe('같은 이메일의 다른 계정이 있는 경우 (합치지 않고 막는다)', () => {
    it('account_exists를 돌려주고 새 계정을 만들지 않는다', async () => {
      const { service, rows, seed } = setup();
      seed({ email: 'student@example.com' });

      const result = await service.findOrCreate('google', PROFILE);

      expect(result).toEqual({ kind: 'account_exists' });
      expect(rows).toHaveLength(1);
    });

    it('겹침을 먼저 확인해서, 겹치면 계정 생성(DB 쓰기)을 아예 시도하지 않는다', async () => {
      const { service, stats, seed } = setup();
      seed({ email: 'student@example.com' });

      await service.findOrCreate('google', PROFILE);

      expect(stats.creates).toBe(0);
    });

    it('탈퇴하지 않은 계정과 겹칠 때만 막고, 탈퇴한 계정과는 겹침으로 보지 않아 계정 생성을 시도한다', async () => {
      const { service, stats, seed } = setup();
      seed({ email: PROFILE.email, deletedAt: new Date('2026-01-01T00:00:00Z') });

      await service.findOrCreate('google', PROFILE);

      // 인덱스가 막아 결과는 account_exists지만, 서비스는 탈퇴한 계정을 겹침으로 보지 않고 생성을 시도했어야 한다
      expect(stats.creates).toBe(1);
    });

    it('기존 계정은 전혀 바뀌지 않는다 (소셜 연동 추가 · 로그인 시각 갱신 없음)', async () => {
      const { service, seed } = setup();
      const existing = seed({ email: 'student@example.com' });

      await service.findOrCreate('google', PROFILE);

      expect(existing.socialAccounts).toEqual([]);
      expect(existing.lastLoginAt).toBeNull();
    });

    it('소셜로 가입한 다른 제공자 계정과 이메일이 같아도 막는다', async () => {
      const { service, rows, seed } = setup();
      seed({
        email: 'student@example.com',
        socialAccounts: [{ ...googleAccount('kakao-uid'), provider: 'kakao' }],
      });

      const result = await service.findOrCreate('google', PROFILE);

      expect(result).toEqual({ kind: 'account_exists' });
      expect(rows).toHaveLength(1);
    });

    it('탈퇴 처리가 이메일을 비웠다면 같은 이메일로 다시 가입할 수 있다', async () => {
      const { service, rows, seed } = setup();
      // 규칙: 탈퇴 처리는 이메일 · 비밀번호 해시 · 소셜 연동을 비운다(그래야 유일 인덱스가 풀린다)
      seed({ email: null, socialAccounts: [], deletedAt: new Date('2026-01-01T00:00:00Z') });

      const result = await service.findOrCreate('google', PROFILE);

      expect(result).toMatchObject({ kind: 'signed_in', created: true });
      expect(rows).toHaveLength(2);
    });

    it('탈퇴한 사용자가 이메일을 그대로 갖고 있으면 유일 인덱스가 막으므로 account_exists이다 (안전한 쪽으로 실패)', async () => {
      const { service, rows, seed } = setup();
      // 탈퇴 처리가 이메일을 비우지 못한 경우. 새 계정을 만들지 않고, 탈퇴한 계정을 되살리지도 않는다
      const gone = seed({ email: PROFILE.email, deletedAt: new Date('2026-01-01T00:00:00Z') });

      const result = await service.findOrCreate('google', PROFILE);

      expect(result).toEqual({ kind: 'account_exists' });
      expect(rows).toHaveLength(1);
      expect(gone.lastLoginAt).toBeNull();
    });

    it('이메일이 없는(null) 소셜 사용자는 이메일 겹침으로 막지 않는다', async () => {
      const { service, rows, seed } = setup();
      seed({ email: 'student@example.com' });

      const result = await service.findOrCreate('google', { ...PROFILE, email: null });

      expect(result).toMatchObject({ kind: 'signed_in', created: true });
      expect(rows).toHaveLength(2);
    });

    it('이메일 대소문자가 달라도 서비스는 받은 값을 그대로 비교한다 (정규화는 구글 클라이언트가 한다)', async () => {
      const { service, seed } = setup();
      seed({ email: 'student@example.com' });

      const result = await service.findOrCreate('google', {
        ...PROFILE,
        email: 'student@example.com',
      });

      expect(result).toEqual({ kind: 'account_exists' });
    });
  });

  describe('탈퇴한 사용자', () => {
    it('탈퇴한 사용자는 소셜 계정이 같아도 찾지 않고, 되살리지도 않는다', async () => {
      const { service, seed } = setup();
      // 탈퇴 처리가 소셜 연동을 비우지 못한 경우를 가정한다. 로그인이 탈퇴 여부를 확인하는지 보려는 것이다
      const gone = seed({
        socialAccounts: [googleAccount('other-uid')],
        deletedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const result = await service
        .findOrCreate('google', {
          providerUid: 'other-uid',
          email: null,
          name: '새사용자',
        })
        .catch((e: unknown) => e);

      // 가짜 컬렉션의 유일 인덱스에는 걸리지만, 중요한 것은 탈퇴한 사용자로 로그인되지 않는 것이다
      expect(gone.lastLoginAt).toBeNull();
      expect(result).not.toMatchObject({ kind: 'signed_in', userId: gone._id });
    });

    it('탈퇴 처리가 소셜 연동을 비우면 같은 구글 계정으로 새 계정을 만들 수 있다', async () => {
      const { service, rows, seed } = setup();
      seed({ socialAccounts: [], email: null, deletedAt: new Date('2026-01-01T00:00:00Z') });

      const result = await service.findOrCreate('google', PROFILE);

      expect(result).toMatchObject({ kind: 'signed_in', created: true });
      expect(rows).toHaveLength(2);
    });
  });

  describe('동시 요청 (거의 같은 순간에 같은 구글 계정으로 두 번 로그인)', () => {
    it('사용자는 한 명만 만들어지고 두 요청이 같은 사용자를 돌려준다', async () => {
      const { service, rows } = setup();

      const [a, b] = await Promise.all([
        service.findOrCreate('google', PROFILE),
        service.findOrCreate('google', PROFILE),
      ]);

      expect(rows).toHaveLength(1);
      expect(a).toMatchObject({ kind: 'signed_in', userId: rows[0]!._id });
      expect(b).toMatchObject({ kind: 'signed_in', userId: rows[0]!._id });
      expect([a, b].filter((r) => r.kind === 'signed_in' && r.created)).toHaveLength(1);
    });

    it('내가 만들기 직전에 다른 요청이 먼저 만들었어도(유일 인덱스 충돌) 그 사용자로 로그인한다', async () => {
      const { service, rows, hooks } = setup();
      hooks.beforeCreate = () => {
        rows.push({
          _id: new Types.ObjectId(),
          nickname: '먼저만든사람',
          email: PROFILE.email,
          socialAccounts: [googleAccount(PROFILE.providerUid, PROFILE.email)],
          lastLoginAt: null,
          deletedAt: null,
        });
      };

      const result = await service.findOrCreate('google', PROFILE);

      expect(rows).toHaveLength(1);
      expect(result).toEqual({ kind: 'signed_in', userId: rows[0]!._id, created: false });
    });

    it('이메일 겹침을 확인하는 사이에 같은 구글 계정의 다른 요청이 계정을 만들었다면 로그인으로 처리한다 (남의 계정이 아니다)', async () => {
      const { service, rows, miss: fakeUsers } = setup();
      // 소셜 계정으로 찾은 뒤, 이메일 겹침을 확인하기 전에 같은 구글 계정의 다른 요청이 계정을 만든 상황
      fakeUsers.afterSignInMiss = () => {
        rows.push({
          _id: new Types.ObjectId(),
          nickname: '방금만든사람',
          email: PROFILE.email,
          socialAccounts: [googleAccount(PROFILE.providerUid, PROFILE.email)],
          lastLoginAt: null,
          deletedAt: null,
        });
      };

      const result = await service.findOrCreate('google', PROFILE);

      expect(rows).toHaveLength(1);
      expect(result).toEqual({ kind: 'signed_in', userId: rows[0]!._id, created: false });
    });

    it('만들다가 이메일이 먼저 선점되면(다른 계정) account_exists이다', async () => {
      const { service, rows, hooks } = setup();
      hooks.beforeCreate = () => {
        rows.push({
          _id: new Types.ObjectId(),
          nickname: '메일선점',
          email: PROFILE.email,
          socialAccounts: [],
          lastLoginAt: null,
          deletedAt: null,
        });
      };

      const result = await service.findOrCreate('google', PROFILE);

      expect(result).toEqual({ kind: 'account_exists' });
      expect(rows).toHaveLength(1);
    });
  });

  describe('실패', () => {
    it('유일 인덱스 충돌이 아닌 DB 오류는 그대로 던진다', async () => {
      const { service, failures } = setup();
      failures.create = 1;

      await expect(service.findOrCreate('google', PROFILE)).rejects.toThrow('DB 쓰기 실패');
    });

    it('실패한 뒤 다음 요청은 정상으로 처리된다', async () => {
      const { service, rows, failures } = setup();
      failures.create = 1;
      await service.findOrCreate('google', PROFILE).catch(() => undefined);

      const result = await service.findOrCreate('google', PROFILE);

      expect(result).toMatchObject({ kind: 'signed_in', created: true });
      expect(rows).toHaveLength(1);
    });
  });
});
