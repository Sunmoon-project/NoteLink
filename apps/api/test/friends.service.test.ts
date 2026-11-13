import { ERROR_CODES } from '@notelink/shared';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FRIEND_ERRORS,
  FriendsService,
  pairOf,
} from '../src/modules/social/friends/friends.service.js';
import { matches, type Row } from './support/fake-collection.js';

/** 서비스가 쓰는 연산만 갖춘 메모리 모델. 조건 해석은 공용 matches를 쓴다 */
function model(rows: Row[], unique?: (a: Row, b: Row) => boolean) {
  // 얕은 복사: ObjectId · Date 인스턴스를 그대로 둔다(structuredClone은 ObjectId를 일반 객체로 바꾼다)
  const copy = (r: Row | null) => (r ? { ...r } : r);
  const lean = (v: Row | null) => ({ lean: () => Promise.resolve(copy(v)) });
  const chain = (found: Row[]) => ({
    select: () => chain(found),
    sort: (by: Record<string, 1 | -1>) => {
      const [[key, dir]] = Object.entries(by) as [[string, 1 | -1]];
      return chain(
        [...found].sort((a, b) => ((a[key] as Date).getTime() - (b[key] as Date).getTime()) * dir),
      );
    },
    lean: () => Promise.resolve(found.map((r) => ({ ...r }))),
  });
  return {
    rows,
    findOne: (f: Record<string, unknown>) => {
      const hit = rows.find((r) => matches(r, f)) ?? null;
      return { ...lean(hit), select: () => lean(hit) };
    },
    find: (f: Record<string, unknown>) => chain(rows.filter((r) => matches(r, f))),
    exists: (f: Record<string, unknown>) =>
      Promise.resolve(rows.some((r) => matches(r, f)) ? { _id: new Types.ObjectId() } : null),
    create: (data: Record<string, unknown>) => {
      const row = { _id: new Types.ObjectId(), ...data } as Row;
      if (unique && rows.some((r) => unique(r, row))) {
        return Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }));
      }
      rows.push(row);
      return Promise.resolve(row);
    },
    updateOne: (f: Record<string, unknown>, u: { $set: Record<string, unknown> }) => {
      const row = rows.find((r) => matches(r, f));
      if (row) Object.assign(row, u.$set);
      return Promise.resolve({ matchedCount: row ? 1 : 0 });
    },
    deleteOne: (f: Record<string, unknown>) => {
      const i = rows.findIndex((r) => matches(r, f));
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({ deletedCount: i >= 0 ? 1 : 0 });
    },
    deleteMany: (f: Record<string, unknown>) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, f)) rows.splice(i, 1);
      return Promise.resolve({ deletedCount: before - rows.length });
    },
  };
}

const NOW = new Date('2026-11-13T00:00:00Z');
let users: Row[];
let friendships: ReturnType<typeof model>;
let shares: ReturnType<typeof model>;
let service: FriendsService;
const person = (nickname: string, extra: Record<string, unknown> = {}) => {
  const row = { _id: new Types.ObjectId(), nickname, status: 'active', deletedAt: null, ...extra };
  users.push(row);
  return row._id.toHexString();
};

beforeEach(() => {
  users = [];
  friendships = model(
    [],
    (a, b) => String(a.userA) === String(b.userA) && String(a.userB) === String(b.userB),
  );
  shares = model([]);
  service = new FriendsService(friendships as never, model(users) as never, shares as never);
});

describe('친구 찾기', () => {
  it('닉네임이 같은 사람을 찾고, 나 · 탈퇴한 사람 · 빈 검색어는 뺀다', async () => {
    const me = person('나');
    const jiwoo = person('지우');
    person('탈퇴', { deletedAt: NOW });
    expect(await service.search(me, ' 지우 ')).toEqual([
      { _id: jiwoo, userId: jiwoo, nickname: '지우', status: 'active' },
    ]);
    expect(await service.search(me, '나')).toEqual([]);
    expect(await service.search(me, '탈퇴')).toEqual([]);
    expect(await service.search(me, '  ')).toEqual([]);
  });
});

describe('친구 요청 · 수락 · 거절', () => {
  it('요청하면 상대에게 받은 요청으로 보이고, 수락하면 둘 다 친구 목록에 서로 나온다', async () => {
    const me = person('나');
    const you = person('지우');
    await service.request(me, you, NOW);
    expect(await service.received(me)).toEqual([]);
    const [req] = await service.received(you);
    expect(req).toMatchObject({
      requester: { userId: me, nickname: '나' },
      requestedAt: NOW.toISOString(),
    });
    await service.respond(you, req!._id, true, NOW);
    expect((await service.friends(me)).map((f) => f.userId)).toEqual([you]);
    expect((await service.friends(you)).map((f) => f.userId)).toEqual([me]);
    expect(await service.received(you)).toEqual([]);
  });

  it('같은 요청을 두 번 보내도 하나, 서로 요청하면 바로 친구, 이미 친구면 409', async () => {
    const me = person('나');
    const you = person('지우');
    await service.request(me, you, NOW);
    await service.request(me, you, NOW);
    expect(friendships.rows).toHaveLength(1);
    await service.request(you, me, NOW);
    expect(friendships.rows[0]).toMatchObject({ status: 'accepted', acceptedAt: NOW });
    await expect(service.request(me, you, NOW)).rejects.toMatchObject({
      response: { code: FRIEND_ERRORS.ALREADY },
    });
  });

  it('나 · 없는 사람 · 이상한 id에는 요청할 수 없다', async () => {
    const me = person('나');
    await expect(service.request(me, me)).rejects.toMatchObject({
      response: { code: FRIEND_ERRORS.SELF },
    });
    await expect(service.request(me, new Types.ObjectId().toHexString())).rejects.toMatchObject({
      response: { code: ERROR_CODES.NOT_FOUND },
    });
    await expect(service.request(me, 'not-an-id')).rejects.toMatchObject({
      response: { code: ERROR_CODES.NOT_FOUND },
    });
  });

  it('거절하면 목록에서 빠지고, 다시 요청하면 새 요청으로 되살아난다', async () => {
    const me = person('나');
    const you = person('지우');
    await service.request(me, you, NOW);
    const [req] = await service.received(you);
    await service.respond(you, req!._id, false);
    expect(await service.received(you)).toEqual([]);
    expect(await service.friends(me)).toEqual([]);
    const later = new Date(NOW.getTime() + 1000);
    await service.request(me, you, later);
    expect(await service.received(you)).toMatchObject([{ requestedAt: later.toISOString() }]);
  });

  it('보낸 사람이나 다른 사람은 그 요청을 수락할 수 없다', async () => {
    const me = person('나');
    const you = person('지우');
    const other = person('수민');
    await service.request(me, you, NOW);
    const id = friendships.rows[0]!._id.toHexString();
    await expect(service.respond(me, id, true)).rejects.toMatchObject({
      response: { code: ERROR_CODES.NOT_FOUND },
    });
    await expect(service.respond(other, id, true)).rejects.toMatchObject({
      response: { code: ERROR_CODES.NOT_FOUND },
    });
    expect(friendships.rows[0]!.status).toBe('pending');
  });
});

describe('친구 목록 · 삭제', () => {
  it('목록은 닉네임 순이고 탈퇴한 친구는 빠진다', async () => {
    const me = person('나');
    const names = ['하은', '가람', '탈퇴함'];
    for (const n of names) {
      const id = person(n, n === '탈퇴함' ? { deletedAt: NOW } : {});
      friendships.rows.push({
        _id: new Types.ObjectId(),
        ...pairOf(new Types.ObjectId(me), new Types.ObjectId(id)),
        requesterId: new Types.ObjectId(me),
        status: 'accepted',
        requestedAt: NOW,
      });
    }
    expect((await service.friends(me)).map((f) => f.nickname)).toEqual(['가람', '하은']);
  });

  it('친구를 끊으면 관계와 서로의 시간표 공유가 함께 지워지고, 남의 공유는 남는다', async () => {
    const me = person('나');
    const you = person('지우');
    const other = person('수민');
    await service.request(me, you, NOW);
    await service.request(you, me, NOW);
    const oid = (id: string) => new Types.ObjectId(id);
    shares.rows.push(
      { _id: new Types.ObjectId(), ownerId: oid(me), friendId: oid(you) },
      { _id: new Types.ObjectId(), ownerId: oid(you), friendId: oid(me) },
      { _id: new Types.ObjectId(), ownerId: oid(me), friendId: oid(other) },
    );
    await service.remove(me, you);
    expect(await service.friends(you)).toEqual([]);
    expect(shares.rows.map((s) => String(s.friendId))).toEqual([other]);
    // 친구가 아니어도 오류 없이 끝난다
    await expect(service.remove(me, other)).resolves.toBeUndefined();
  });
});

it('한 쌍은 늘 같은 순서(id 작은 쪽이 userA)로 둔다', () => {
  const a = new Types.ObjectId('000000000000000000000001');
  const b = new Types.ObjectId('000000000000000000000002');
  expect(pairOf(b, a)).toEqual({ userA: a, userB: b });
  expect(pairOf(a, b)).toEqual({ userA: a, userB: b });
});
