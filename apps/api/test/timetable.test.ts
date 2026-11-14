import type { INestApplication } from '@nestjs/common';
import { Timetable } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTimetableTestApp } from './timetable-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

type ClassRow = { _id: Types.ObjectId; subjectName: string; days: number[]; startTime: string; endTime: string; location: string; color: string; source: string };
type TtRow = { _id: Types.ObjectId; userId: Types.ObjectId; classes: ClassRow[]; updatedAt: Date };
type ShareRow = { _id: Types.ObjectId; ownerId: Types.ObjectId; friendId: Types.ObjectId; mode: string; sharedAt: Date; friendshipId?: Types.ObjectId | null };
type FriendRow = { _id?: Types.ObjectId; userA: Types.ObjectId; userB: Types.ObjectId; status: string };

let tts: TtRow[];
let shares: ShareRow[];
let friendships: FriendRow[];

const ME = new Types.ObjectId(TEST_USER_ID);

const timetableModel = {
    findOne: vi.fn((f: { userId: Types.ObjectId }) => ({
        lean: vi.fn(() => Promise.resolve(tts.find((t) => t.userId.equals(f.userId)) ?? null)),
    })),
    updateOne: vi.fn(
        (
            f: { userId: Types.ObjectId; 'classes._id'?: Types.ObjectId },
            u: { $push?: { classes: ClassRow }; $pull?: { classes: { _id: Types.ObjectId } } },
            opts?: { upsert?: boolean },
        ) => {
            let row = tts.find((t) => t.userId.equals(f.userId) && (!f['classes._id'] || t.classes.some((c) => c._id.equals(f['classes._id']!))));
            if (!row && opts?.upsert && u.$push) {
                row = { _id: new Types.ObjectId(), userId: f.userId, classes: [], updatedAt: new Date() };
                tts.push(row);
            }
            if (!row) return Promise.resolve({ matchedCount: 0 });
            if (u.$push) row.classes.push(u.$push.classes);
            if (u.$pull) row.classes = row.classes.filter((c) => !c._id.equals(u.$pull!.classes._id));
            row.updatedAt = new Date();
            return Promise.resolve({ matchedCount: 1 });
        },
    ),
};
type ShareFilter = { ownerId: Types.ObjectId; friendId: Types.ObjectId; friendshipId?: { $in: (Types.ObjectId | null)[] } };
type ShareSet = { mode: string; sharedAt: Date; friendshipId?: Types.ObjectId };
const samePair = (f: ShareFilter) => (s: ShareRow) => s.ownerId.equals(f.ownerId) && s.friendId.equals(f.friendId);
const shareHit = (f: ShareFilter) => (s: ShareRow) =>
    samePair(f)(s) && (!f.friendshipId || f.friendshipId.$in.some((id) => (id === null ? s.friendshipId == null : String(id) === String(s.friendshipId))));
const shareModel = {
    bulkWrite: vi.fn((ops: { updateOne: { filter: ShareFilter; update: { $set: ShareSet }; upsert?: boolean } }[]) => {
        const writeErrors: { code: number; index: number }[] = [];
        ops.forEach(({ updateOne: op }, index) => {
            const row = shares.find(shareHit(op.filter));
            if (row) Object.assign(row, op.update.$set);
            // 조건에 안 맞는데 같은 쌍의 줄이 있으면, 끼워 넣기가 유일 인덱스({ ownerId, friendId })에 걸린다
            else if (shares.some(samePair(op.filter))) writeErrors.push({ code: 11000, index });
            else shares.push({ _id: new Types.ObjectId(), ownerId: op.filter.ownerId, friendId: op.filter.friendId, ...op.update.$set });
        });
        return writeErrors.length ? Promise.reject(Object.assign(new Error('E11000'), { writeErrors })) : Promise.resolve({});
    }),
    findOne: vi.fn((f: ShareFilter) => {
        const row = shares.find(samePair(f));
        const lean = vi.fn(() => Promise.resolve(row ? { ...row } : null));
        return { select: vi.fn(() => ({ lean })), lean };
    }),
    /** friendshipId 조건은 값 하나(null 포함) 또는 { $in } */
    updateOne: vi.fn(
        (f: Omit<ShareFilter, 'friendshipId'> & { friendshipId: Types.ObjectId | null | { $in: (Types.ObjectId | null)[] } }, u: { $set: ShareSet }, o?: { upsert?: boolean }) => {
            const pair = { ownerId: f.ownerId, friendId: f.friendId };
            const wanted = f.friendshipId && '$in' in f.friendshipId ? f.friendshipId.$in : [f.friendshipId as Types.ObjectId | null];
            const row = shares.find(shareHit({ ...pair, friendshipId: { $in: wanted } }));
            if (row) {
                Object.assign(row, u.$set);
                return Promise.resolve({ matchedCount: 1 });
            }
            if (!o?.upsert) return Promise.resolve({ matchedCount: 0 });
            if (shares.some(samePair(pair))) return Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }));
            shares.push({ _id: new Types.ObjectId(), ownerId: f.ownerId, friendId: f.friendId, ...u.$set });
            return Promise.resolve({ matchedCount: 0 });
        },
    ),
    deleteMany: vi.fn((f: { ownerId: Types.ObjectId; $or: { friendId: Types.ObjectId; friendshipId: Types.ObjectId }[] }) => {
        shares = shares.filter(
            (s) => !(s.ownerId.equals(f.ownerId) && f.$or.some((o) => o.friendId.equals(s.friendId) && String(o.friendshipId) === String(s.friendshipId))),
        );
        return Promise.resolve({});
    }),
    find: vi.fn((f: { ownerId: Types.ObjectId }) => {
        const rows = shares.filter((s) => s.ownerId.equals(f.ownerId));
        const chain = {
            sort: vi.fn(() => {
                rows.sort((a, b) => a.sharedAt.getTime() - b.sharedAt.getTime());
                return chain;
            }),
            lean: vi.fn(() => Promise.resolve(rows)),
        };
        return chain;
    }),
};
type FriendFilter = { status: string; $or: { userA: Types.ObjectId; userB: { $in: Types.ObjectId[] } }[] | { userB: Types.ObjectId; userA: { $in: Types.ObjectId[] } }[] };
const friendshipModel = {
    exists: vi.fn((f: { _id: Types.ObjectId; status: string }) =>
        Promise.resolve(friendships.some((r) => String(r._id) === String(f._id) && r.status === f.status) ? { _id: f._id } : null),
    ),
    find: vi.fn((f: FriendFilter) => {
        const [a, b] = f.$or as [{ userA: Types.ObjectId; userB: { $in: Types.ObjectId[] } }, { userB: Types.ObjectId; userA: { $in: Types.ObjectId[] } }];
        const has = (list: Types.ObjectId[], id: Types.ObjectId) => list.some((x) => x.equals(id));
        const rows = friendships.filter(
            (r) => r.status === f.status && ((r.userA.equals(a.userA) && has(a.userB.$in, r.userB)) || (r.userB.equals(b.userB) && has(b.userA.$in, r.userA))),
        );
        // 관계 문서 id가 없으면 만들어 둔다(공유가 어느 관계로 만들어졌는지 friendshipId로 남긴다)
        for (const r of rows) r._id ??= new Types.ObjectId();
        return { lean: vi.fn(() => Promise.resolve(rows)) };
    }),
};

const MATH = { subjectName: '수학 II', days: [4, 2], startTime: '10:00', endTime: '11:30', location: '공학관 301', color: '#dfece4' };

describe('시간표 API (/timetable)', () => {
    let app: INestApplication;
    const url = (p = '') => `/api/v1/timetable${p}`;
    const http = () => request(app.getHttpServer());
    const addClass = (body: object = MATH) => http().post(url('/classes')).set(AUTH).send(body);
    const shareWith = (friendIds: string[], mode = 'full') => http().post(url('/shares')).set(AUTH).send({ friendIds, mode });

    beforeAll(async () => {
        app = await createTimetableTestApp({ timetable: timetableModel, share: shareModel, friendship: friendshipModel });
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(() => {
        tts = [];
        shares = [];
        friendships = [];
        vi.clearAllMocks();
    });

    it('로그인 없이는 401', async () => {
        for (const path of [url(), url('/shares')]) {
            const res = await http().get(path);
            expect(res.status).toBe(401);
            expect(res.body.code).toBe('AUTH_TOKEN_EXPIRED');
        }
    });

    it('수업이 없으면 빈 시간표를 주고 저장하지는 않는다', async () => {
        const res = await http().get(url()).set(AUTH);
        expect(res.status).toBe(200);
        expect(res.body.data.classes).toEqual([]);
        expect(typeof res.body.data._id).toBe('string');
        expect(tts).toHaveLength(0);
    });

    it('수업을 추가하면 201과 함께 요일 정렬·source=manual로 돌려주고, 시간표에 보인다', async () => {
        const res = await addClass();
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ ...MATH, days: [2, 4], source: 'manual' });
        expect(typeof res.body.data._id).toBe('string');

        const tt = await http().get(url()).set(AUTH);
        expect(tt.body.data.classes).toHaveLength(1);
        expect(tt.body.data.classes[0]._id).toBe(res.body.data._id);
        expect(tts).toHaveLength(1);

        await addClass({ ...MATH, subjectName: '국어' });
        expect(tts).toHaveLength(1); // 시간표는 사용자당 한 건
        expect((await http().get(url()).set(AUTH)).body.data.classes).toHaveLength(2);
    });

    it('장소는 선택이라 없으면 빈 글자', async () => {
        const { location: _omit, ...noLocation } = MATH;
        const res = await addClass(noLocation);
        expect(res.status).toBe(201);
        expect(res.body.data.location).toBe('');
    });

    it('source가 없는 예전 형식 수업도 source=manual로 내려가고 공유 계약(Timetable)을 통과한다', async () => {
        const { source: _omit, ...legacy } = { _id: new Types.ObjectId(), ...MATH, source: 'manual' };
        tts.push({ _id: new Types.ObjectId(), userId: ME, classes: [legacy as ClassRow], updatedAt: new Date() });
        const res = await http().get(url()).set(AUTH);
        expect(res.status).toBe(200);
        expect(res.body.data.classes[0].source).toBe('manual');
        expect(Timetable.safeParse(res.body.data).success).toBe(true);
    });

    it.each([
        ['과목명 없음', { ...MATH, subjectName: '' }],
        ['요일 없음', { ...MATH, days: [] }],
        ['요일 범위 밖', { ...MATH, days: [7] }],
        ['요일 중복', { ...MATH, days: [1, 1] }],
        ['시작 시간 형식', { ...MATH, startTime: '9:00' }],
        ['끝나는 시간이 시작과 같음', { ...MATH, endTime: '10:00' }],
        ['끝나는 시간이 시작보다 이름', { ...MATH, startTime: '11:00', endTime: '10:00' }],
        ['색 형식', { ...MATH, color: 'green' }],
        ['모르는 필드', { ...MATH, hack: true }],
    ])('잘못된 수업은 400: %s', async (_label, body) => {
        const res = await addClass(body);
        expect(res.status).toBe(400);
        expect(tts).toHaveLength(0);
    });

    it('수업을 지우면 204, 시간표에서 빠진다', async () => {
        const a = await addClass();
        const b = await addClass({ ...MATH, subjectName: '국어' });
        expect((await http().delete(url(`/classes/${a.body.data._id}`)).set(AUTH)).status).toBe(204);
        const left = (await http().get(url()).set(AUTH)).body.data.classes;
        expect(left.map((c: { _id: string }) => c._id)).toEqual([b.body.data._id]);
    });

    it('없는 수업·남의 수업·이상한 id를 지우면 404', async () => {
        const mine = await addClass();
        const other: TtRow = {
            _id: new Types.ObjectId(),
            userId: new Types.ObjectId(),
            classes: [{ _id: new Types.ObjectId(), ...MATH, source: 'manual' }],
            updatedAt: new Date(),
        };
        tts.push(other);
        expect((await http().delete(url(`/classes/${new Types.ObjectId()}`)).set(AUTH)).status).toBe(404);
        expect((await http().delete(url(`/classes/${other.classes[0]!._id}`)).set(AUTH)).status).toBe(404);
        expect((await http().delete(url('/classes/not-an-id')).set(AUTH)).status).toBe(404);
        expect(other.classes).toHaveLength(1);
        expect((await http().get(url()).set(AUTH)).body.data.classes[0]._id).toBe(mine.body.data._id);
    });

    describe('친구 공유', () => {
        const friend = new Types.ObjectId();
        const friend2 = new Types.ObjectId();
        const stranger = new Types.ObjectId();
        beforeEach(() => {
            friendships = [
                { userA: ME, userB: friend, status: 'accepted' },
                { userA: friend2, userB: ME, status: 'accepted' }, // 상대가 userA인 경우
            ];
        });

        it('친구에게 공유하면 204, 공유 목록에 mode와 함께 보인다', async () => {
            const res = await shareWith([friend.toString(), friend2.toString()], 'free_only');
            expect(res.status).toBe(204);
            const list = await http().get(url('/shares')).set(AUTH);
            expect(list.status).toBe(200);
            expect(list.body.data).toHaveLength(2);
            expect(list.body.data.map((s: { friendId: string }) => s.friendId).sort()).toEqual([friend.toString(), friend2.toString()].sort());
            expect(list.body.data[0]).toMatchObject({ mode: 'free_only' });
            expect(typeof list.body.data[0].sharedAt).toBe('string');
        });

        it('친구 ID를 대문자로 보내도 204로 공유된다', async () => {
            const res = await shareWith([friend.toString().toUpperCase()]);
            expect(res.status).toBe(204);
            expect(shares).toHaveLength(1);
            expect(shares[0]?.friendId.equals(friend)).toBe(true);
        });

        it('같은 ID를 대문자·소문자로 함께 보내도 공유는 한 건만 저장된다', async () => {
            const res = await shareWith([friend.toString(), friend.toString().toUpperCase()]);
            expect(res.status).toBe(204);
            expect(shares).toHaveLength(1);
            expect(shareModel.bulkWrite.mock.calls[0]![0]).toHaveLength(1);
        });

        it('이미 공유 중인 친구에게 다시 공유하면 한 건 그대로 방식만 바뀐다', async () => {
            await shareWith([friend.toString()], 'full');
            await shareWith([friend.toString()], 'free_only');
            expect(shares).toHaveLength(1);
            expect(shares[0]?.mode).toBe('free_only');
        });

        it('친구가 아닌 사람이 하나라도 섞여 있으면 400 NOT_FRIEND이고 아무에게도 공유하지 않는다', async () => {
            const res = await shareWith([friend.toString(), stranger.toString()]);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('NOT_FRIEND');
            expect(shares).toHaveLength(0);
        });

        it('친구 확인 뒤 공유를 쓰는 사이에 친구를 끊었으면 쓴 공유를 지운다(공유한 뒤 끊긴 것과 같은 결과)', async () => {
            // 공유 쓰기 직전에 친구 끊기(관계 삭제 → 공유 정리)가 끝까지 돈다
            const write = shareModel.bulkWrite.getMockImplementation()!;
            shareModel.bulkWrite.mockImplementationOnce((ops) => {
                friendships = [];
                shares = [];
                return write(ops);
            });
            const res = await shareWith([friend.toString()]);
            expect(res.status).toBe(204);
            expect(shares).toHaveLength(0);
        });

        it('끊긴 사람의 공유를 지우기 전에 다시 친구가 되어 새로 공유했으면(같은 밀리초여도) 그 새 공유는 남긴다', async () => {
            const refriended = new Types.ObjectId();
            // 다시 확인 직전: 끊겼다가 다시 친구가 되어(새 관계 문서) 새 공유 요청이 성공했다. 시각은 이 요청과 같다
            const find = friendshipModel.find.getMockImplementation()!;
            friendshipModel.find
                .mockImplementationOnce(find) // 처음 확인: 원래 관계
                .mockImplementationOnce((f) => {
                    friendships = friendships.map((r) => (r.userB.equals(friend) ? { ...r, _id: refriended } : r));
                    const mine = shares.find((x) => x.friendId.equals(friend))!;
                    Object.assign(mine, { mode: 'free_only', friendshipId: refriended }); // sharedAt은 그대로(같은 밀리초)
                    return find(f);
                });
            const res = await shareWith([friend.toString()], 'full');
            expect(res.status).toBe(204);
            expect(shares).toHaveLength(1);
            expect(shares[0]).toMatchObject({ mode: 'free_only', friendshipId: refriended });
        });

        it('예전 관계로 시작한 요청이 늦게 쓰면, 다시 친구가 된 뒤의 새 공유를 덮어쓰거나 지우지 않는다', async () => {
            const renewed = new Types.ObjectId();
            const write = shareModel.bulkWrite.getMockImplementation()!;
            shareModel.bulkWrite.mockImplementationOnce((ops) => {
                // 이 요청이 처음 확인한 뒤 쓰기 전에: 친구 끊기 → 다시 친구(새 관계) → 새 공유(free_only) 완료
                friendships = friendships.map((r) => (r.userB.equals(friend) ? { ...r, _id: renewed } : r));
                shares.push({ _id: new Types.ObjectId(), ownerId: ME, friendId: friend, mode: 'free_only', sharedAt: new Date(), friendshipId: renewed });
                return write(ops);
            });
            const res = await shareWith([friend.toString()], 'full');
            expect(res.status).toBe(204);
            expect(shares).toHaveLength(1);
            expect(shares[0]).toMatchObject({ mode: 'free_only', friendshipId: renewed });
        });

        it('끊긴 예전 관계의 공유가 아직 남아 있으면 새 관계의 공유로 바꿔 써서, 늦은 정리 뒤에도 공유가 남는다', async () => {
            const ended = new Types.ObjectId(); // friend와의 예전 관계(이미 지워졌고, 공유 정리는 아직)
            shares.push({ _id: new Types.ObjectId(), ownerId: ME, friendId: friend, mode: 'full', sharedAt: new Date('2026-11-01T00:00:00Z'), friendshipId: ended });
            const res = await shareWith([friend.toString()], 'free_only');
            expect(res.status).toBe(204);
            const live = friendships.find((r) => r.userB.equals(friend))!._id!;
            expect(shares).toHaveLength(1);
            expect(shares[0]).toMatchObject({ mode: 'free_only', friendshipId: live });
            // 친구 끊기의 늦은 정리(예전 관계 id · null만)는 새 공유를 지우지 않는다
            shares = shares.filter((x) => !(x.friendshipId == null || String(x.friendshipId) === String(ended)));
            expect(shares).toHaveLength(1);
        });

        it('같은 관계의 공유와 관계 id가 없는 예전 공유는 덮어쓴다', async () => {
            shares.push({ _id: new Types.ObjectId(), ownerId: ME, friendId: friend, mode: 'full', sharedAt: new Date('2026-11-01T00:00:00Z') });
            expect((await shareWith([friend.toString()], 'free_only')).status).toBe(204);
            expect(shares).toHaveLength(1);
            expect(shares[0]!.mode).toBe('free_only');
            expect(shares[0]!.friendshipId).toBeDefined();
            expect((await shareWith([friend.toString()], 'full')).status).toBe(204);
            expect(shares[0]!.mode).toBe('full');
        });

        it('두 친구에게 공유하는 사이 한 명과 끊기면 그 사람 공유만 지우고, 남은 친구의 공유는 요청대로 둔다', async () => {
            shares.push({ _id: new Types.ObjectId(), ownerId: ME, friendId: friend, mode: 'full', sharedAt: new Date('2026-11-01T00:00:00Z') });
            const write = shareModel.bulkWrite.getMockImplementation()!;
            shareModel.bulkWrite.mockImplementationOnce((ops) => {
                // 쓰기 직전에 friend2와의 친구 끊기(관계 삭제 → 공유 정리)가 끝까지 돈다
                friendships = friendships.filter((r) => !(r.userA.equals(friend2) || r.userB.equals(friend2)));
                shares = shares.filter((x) => !x.friendId.equals(friend2));
                return write(ops);
            });
            const res = await shareWith([friend.toString(), friend2.toString()], 'free_only');
            expect(res.status).toBe(204);
            expect(shares).toHaveLength(1);
            expect(shares[0]!.friendId.equals(friend)).toBe(true);
            expect(shares[0]!.mode).toBe('free_only');
        });

        it('수락 전(pending)·거절된 관계는 친구로 치지 않는다', async () => {
            const pending = new Types.ObjectId();
            friendships.push({ userA: ME, userB: pending, status: 'pending' });
            expect((await shareWith([pending.toString()])).status).toBe(400);
        });

        it('내 공유 목록에는 남이 한 공유가 섞이지 않는다', async () => {
            shares.push({ _id: new Types.ObjectId(), ownerId: new Types.ObjectId(), friendId: friend, mode: 'full', sharedAt: new Date() });
            expect((await http().get(url('/shares')).set(AUTH)).body.data).toEqual([]);
        });

        it.each([
            ['친구 목록이 비어 있음', { friendIds: [], mode: 'full' }],
            ['id 형식이 아님', { friendIds: ['abc'], mode: 'full' }],
            ['id 중복', { friendIds: ['64b000000000000000000001', '64b000000000000000000001'], mode: 'full' }],
            ['mode가 이상함', { friendIds: ['64b000000000000000000001'], mode: 'public' }],
            ['mode 없음', { friendIds: ['64b000000000000000000001'] }],
        ])('잘못된 공유 요청은 400: %s', async (_label, body) => {
            expect((await http().post(url('/shares')).set(AUTH).send(body)).status).toBe(400);
            expect(shares).toHaveLength(0);
        });
    });
});
