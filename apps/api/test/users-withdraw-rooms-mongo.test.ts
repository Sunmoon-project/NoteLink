import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';
import { StudyRoomMembershipService } from '../src/modules/studyroom/study-room-membership.service.js';
import { UsersService } from '../src/modules/users/users.service.js';

// 회원 탈퇴가 스터디룸에서 나가는 것(기존 leaveRoom)까지 실제 MongoDB로 확인한다.
// 명시적으로 지정한 로컬 DB에서만 실행한다(스터디룸 실DB 테스트와 같은 환경 변수).
const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);

describe.skipIf(!local)('회원 탈퇴 · 스터디룸 나가기 실제 MongoDB', () => {
  const suffix = randomBytes(8).toString('hex');
  const names = ['rooms', 'users'].map((name) => `test_withdraw_${name}_${suffix}`);
  const category = new Types.ObjectId();
  const first = new Types.ObjectId();
  const second = new Types.ObjectId();
  const third = new Types.ObjectId();
  let connection: mongoose.Connection;
  let rooms: mongoose.Model<StudyRoom>;
  let users: mongoose.Model<User>;
  let service: UsersService;
  let sequence = 0;
  // 소켓 · LiveKit 은 가짜: 어느 방에서 어떤 순서로 불렸는지만 본다
  let calls: string[];
  const gateway = {
    evict: vi.fn(async (roomId: string) => void calls.push(`evict:${roomId}`)),
    notifyMembersChanged: vi.fn((roomId: string) => void calls.push(`notify:${roomId}`)),
  };
  const live = {
    disconnect: vi.fn(async (roomId: string) => void calls.push(`disconnect:${roomId}`)),
  };

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri!, { serverSelectionTimeoutMS: 5000 })
      .asPromise();
    rooms = connection.model(StudyRoom.name, StudyRoomSchema, names[0]);
    users = connection.model(User.name, UserSchema, names[1]);
    await rooms.init();
    const roomsService = new StudyRoomsService(rooms, users, {} as never, {} as never);
    const nothing = { deleteMany: async () => ({ deletedCount: 0 }) };
    service = new UsersService(
      users,
      { streakDays: async () => 0 } as never,
      nothing as never,
      { revokeAll: async () => undefined } as never,
      nothing as never,
      nothing as never,
      new StudyRoomMembershipService(roomsService, gateway as never, live as never),
    );
  });
  beforeEach(async () => {
    calls = [];
    vi.clearAllMocks();
    await Promise.all([rooms.deleteMany({}), users.deleteMany({})]);
    await users.collection.insertMany(
      [first, second, third].map((_id, index) => ({
        _id,
        nickname: `사용자${index}`,
        email: `u${index}@example.com`,
        deletedAt: null,
        withdrawingAt: null,
      })),
    );
  });
  afterAll(async () => {
    if (!connection) return;
    await connection.dropCollection(names[0]!).catch(() => {});
    await connection.dropCollection(names[1]!).catch(() => {});
    await connection.close();
  });

  /** members: [사용자, 방장 여부]. 입장 시각은 앞선 사람이 더 이르다 */
  const room = (members: [Types.ObjectId, boolean][], over: Record<string, unknown> = {}) => {
    sequence += 1;
    const joinedAt = (index: number) => new Date(Date.UTC(2026, 10, 1, 0, index));
    return rooms.create({
      title: `방${sequence}-${suffix}`,
      categoryId: category,
      hostId: members.find(([, isHost]) => isHost)![0],
      inviteCode: `W${String(sequence).padStart(5, '0')}`,
      isPublic: true,
      memberCount: members.length,
      maxCapacity: 6,
      members: members.map(([userId, isHost], index) => ({
        userId,
        role: isHost ? 'host' : 'member',
        status: 'joined',
        joinedAt: joinedAt(index),
      })),
      ...over,
    });
  };
  const saved = (id: Types.ObjectId) => rooms.findById(id).lean().orFail();

  it('일반 멤버가 탈퇴하면 방에서 빠지고 memberCount가 줄며 방장은 그대로다', async () => {
    const created = await room([
      [first, true],
      [second, false],
    ]);
    await service.withdraw(String(second));
    // 소켓 해제 → 연결 끊기 → 나가기 → 소켓 해제 → 알림 순서(탈퇴 경로). 나가기는 가짜가 아니라 실제 DB라 calls 에는 안 보인다
    expect(calls).toEqual([
      `evict:${created._id}`,
      `disconnect:${created._id}`,
      `evict:${created._id}`,
      `notify:${created._id}`,
    ]);
    const after = await saved(created._id);
    expect(after.memberCount).toBe(1);
    expect(after.hostId).toEqual(first);
    expect(after.closedAt ?? null).toBeNull();
    expect(after.members.find((m) => m.userId.equals(second))).toMatchObject({
      status: 'left',
      leaveReason: 'voluntary',
    });
  });

  it('방장이 탈퇴하면 먼저 입장한 다음 멤버가 방장이 된다', async () => {
    const created = await room([
      [first, true],
      [second, false],
      [third, false],
    ]);
    await service.withdraw(String(first));
    const after = await saved(created._id);
    expect(after.hostId).toEqual(second);
    expect(after.memberCount).toBe(2);
    expect(after.members.find((m) => m.userId.equals(second))?.role).toBe('host');
    expect(after.members.find((m) => m.userId.equals(first))).toMatchObject({
      role: 'member',
      status: 'left',
    });
    expect(after.closedAt ?? null).toBeNull();
  });

  it('혼자 있던 방장이 탈퇴하면 방이 닫히고 보관 기간이 시작된다', async () => {
    const created = await room([[first, true]]);
    await service.withdraw(String(first));
    const after = await saved(created._id);
    expect(after.closedAt).toBeInstanceOf(Date);
    expect(after.deleteAfter).toBeInstanceOf(Date);
    expect(after.memberCount).toBe(0);
  });

  it('여러 방에 참여 중이면 모두 나가고, 이미 닫힌 방 · 남의 방은 건드리지 않는다', async () => {
    const a = await room([
      [second, true],
      [first, false],
    ]);
    const b = await room([
      [third, true],
      [first, false],
    ]);
    const closed = await room(
      [
        [second, true],
        [first, false],
      ],
      { closedAt: new Date() },
    );
    const others = await room([
      [second, true],
      [third, false],
    ]);
    await service.withdraw(String(first));
    for (const id of [a._id, b._id]) {
      const after = await saved(id);
      expect(after.memberCount).toBe(1);
      expect(after.members.find((m) => m.userId.equals(first))?.status).toBe('left');
    }
    expect((await saved(closed._id)).members.find((m) => m.userId.equals(first))?.status).toBe(
      'joined',
    );
    expect((await saved(others._id)).memberCount).toBe(2);
    expect(await users.findById(first).lean()).toMatchObject({ nickname: `탈퇴-${first}` });
  });
});
