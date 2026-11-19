import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { Timetable, TimetableSchema } from '../src/modules/calendar/schemas/timetable.schema.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../src/modules/calendar/schemas/timetable-share.schema.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';
import { StudyRoomScheduleService } from '../src/modules/studyroom/study-room-schedule.service.js';

const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);
if (process.env.REQUIRE_STUDYROOM_MONGO_TESTS === 'true' && !local) {
  throw new Error('REQUIRE_STUDYROOM_MONGO_TESTS=true requires a local STUDYROOM_TEST_MONGO_URI.');
}

// 스터디룸 시간표: 바쁜 시간은 멤버별로 모두 보이고, 일정 제목은 나 또는 나에게 전체 공개한 친구 것만 보인다
describe.skipIf(!local)('스터디룸 시간표 멤버별 일정 · 제목 공개 범위 실제 MongoDB', () => {
  const suffix = randomBytes(8).toString('hex');
  const names = ['rooms', 'users', 'timetables', 'shares', 'friendships'].map(
    (n) => `test_schedule_${n}_${suffix}`,
  );
  const me = new Types.ObjectId();
  const fullFriend = new Types.ObjectId(); // 나에게 full 공유 + 친구
  const freeFriend = new Types.ObjectId(); // 나에게 free_only 공유 + 친구
  const exFriend = new Types.ObjectId(); // full 공유는 남았지만 친구가 끊김
  const stranger = new Types.ObjectId(); // 친구 아님, 남에게만 full 공유
  const refriend = new Types.ObjectId(); // 다시 친구가 됐지만 full 공유는 옛 관계로 만든 것(무효)
  const roomId = new Types.ObjectId();
  let connection: mongoose.Connection;
  let service: StudyRoomScheduleService;
  const cls = (subjectName: string, days: number[], startTime: string, endTime: string) => ({
    _id: new Types.ObjectId(),
    subjectName,
    days,
    startTime,
    endTime,
    color: '#000000',
    source: 'manual',
  });
  const pair = (a: Types.ObjectId, b: Types.ObjectId) =>
    a.toHexString() < b.toHexString() ? { userA: a, userB: b } : { userA: b, userB: a };

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri!, { serverSelectionTimeoutMS: 5000 })
      .asPromise();
    const rooms = connection.model(StudyRoom.name, StudyRoomSchema, names[0]);
    const users = connection.model(User.name, UserSchema, names[1]);
    const timetables = connection.model(Timetable.name, TimetableSchema, names[2]);
    const shares = connection.model(TimetableShare.name, TimetableShareSchema, names[3]);
    const friendships = connection.model(Friendship.name, FriendshipSchema, names[4]);
    const people = [me, fullFriend, freeFriend, exFriend, stranger, refriend];
    await users.collection.insertMany(
      people.map((_id, i) => ({
        _id,
        nickname: ['나', '전체', '빈시간', '끊긴', '남', '재친구'][i],
        deletedAt: null,
      })),
    );
    await rooms.collection.insertOne({
      _id: roomId,
      title: '시간표 방',
      categoryId: new Types.ObjectId(),
      hostId: me,
      inviteCode: 'SCHED1',
      closedAt: null,
      members: people.map((userId, i) => ({
        userId,
        role: i ? 'member' : 'host',
        status: 'joined',
      })),
    });
    await timetables.collection.insertMany(
      people.map((userId, i) => ({
        userId,
        // 월요일(1) 10:00 – 11:30, 사람마다 다른 제목
        classes: [cls(`비밀과목${i}`, [1], '10:00', '11:30')],
      })),
    );
    await friendships.collection.insertMany([
      { ...pair(me, fullFriend), requesterId: me, status: 'accepted' },
      { ...pair(me, freeFriend), requesterId: me, status: 'accepted' },
      { ...pair(me, refriend), requesterId: me, status: 'accepted' },
    ]);
    await shares.collection.insertMany([
      { ownerId: fullFriend, friendId: me, mode: 'full', sharedAt: new Date() },
      { ownerId: freeFriend, friendId: me, mode: 'free_only', sharedAt: new Date() },
      { ownerId: exFriend, friendId: me, mode: 'full', sharedAt: new Date() },
      { ownerId: stranger, friendId: fullFriend, mode: 'full', sharedAt: new Date() },
      {
        ownerId: refriend,
        friendId: me,
        mode: 'full',
        sharedAt: new Date(),
        friendshipId: new Types.ObjectId(), // 끊긴 예전 관계
      },
    ]);
    const users2 = users as never;
    const chat = new StudyChatService(rooms, {} as never, {} as never, users2, friendships);
    service = new StudyRoomScheduleService(timetables, users, shares, friendships, rooms, chat);
  });
  afterAll(async () => {
    if (!connection) return;
    for (const n of names) await connection.dropCollection(n).catch(() => {});
    await connection.close();
  });

  it('멤버마다 바쁜 시간을 주고, 제목은 나 · 나에게 전체 공개한 친구 것만 준다', async () => {
    const s = await service.schedule(String(roomId), String(me));
    const byName = Object.fromEntries(s.members.map((m) => [m.nickname, m]));
    expect(s.members.map((m) => m.id)).toEqual(
      [me, fullFriend, freeFriend, exFriend, stranger, refriend].map(String),
    );
    // 월요일 = day 0
    expect(byName['나']!.blocks).toEqual([
      { day: 0, start: '10:00', end: '11:30', title: '비밀과목0' },
    ]);
    expect(byName['전체']!.blocks[0]!.title).toBe('비밀과목1');
    for (const n of ['빈시간', '끊긴', '남', '재친구']) {
      expect(byName[n]!.blocks).toEqual([{ day: 0, start: '10:00', end: '11:30', title: null }]);
    }
    // 응답 어디에도 남의 비공개 제목이 없다
    const raw = JSON.stringify(s);
    for (const t of ['비밀과목2', '비밀과목3', '비밀과목4', '비밀과목5'])
      expect(raw).not.toContain(t);
    // 예전 앱이 쓰는 grid · matches는 그대로
    expect(s.grid[1]![0]).toBe(1);
    expect(s.startHour).toBe(9);
  });

  it('보는 사람이 바뀌면 그 사람 기준으로 다시 가린다', async () => {
    const s = await service.schedule(String(roomId), String(fullFriend));
    const titles = Object.fromEntries(s.members.map((m) => [m.nickname, m.blocks[0]!.title]));
    // fullFriend는 나와 친구지만 내가 공유하지 않았다 · stranger는 fullFriend에게 full 공유했지만 친구가 아니다
    expect(titles).toEqual({
      나: null,
      전체: '비밀과목1',
      빈시간: null,
      끊긴: null,
      남: null,
      재친구: null,
    });
  });

  it('내 시간표 시간을 이 방에서 숨기면 blocks는 비고 공통 빈 시간 계산에는 그대로 들어간다 · 남의 설정은 못 바꾼다', async () => {
    await service.setScheduleHidden(String(roomId), String(fullFriend), true);
    const s = await service.schedule(String(roomId), String(me));
    const hidden = s.members.find((m) => m.nickname === '전체')!;
    expect(hidden).toMatchObject({ hidden: true, blocks: [] });
    expect(JSON.stringify(s)).not.toContain('비밀과목1');
    // 다른 멤버는 그대로
    expect(s.members.find((m) => m.nickname === '나')).toMatchObject({ hidden: false });
    // 모두 월 10:00 – 11:30 바쁨: 숨겨도 격자에서는 바쁜 칸
    expect(s.grid[1]![0]).toBe(1);
    // 방 멤버가 아니면 404, 내 설정은 남이 못 바꾼다(요청한 사람 자신의 줄만 바뀐다)
    await expect(
      service.setScheduleHidden(String(roomId), String(new Types.ObjectId()), true),
    ).rejects.toMatchObject({ status: 404 });
    const again = await service.schedule(String(roomId), String(fullFriend));
    expect(again.members.filter((m) => m.hidden).map((m) => m.nickname)).toEqual(['전체']);
    // 다시 켜면 보인다
    await service.setScheduleHidden(String(roomId), String(fullFriend), false);
    const back = await service.schedule(String(roomId), String(me));
    expect(back.members.find((m) => m.nickname === '전체')).toMatchObject({ hidden: false });
    expect(back.members.find((m) => m.nickname === '전체')!.blocks[0]!.title).toBe('비밀과목1');
  });
});
