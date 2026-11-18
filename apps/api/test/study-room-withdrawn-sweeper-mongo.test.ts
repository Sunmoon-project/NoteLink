import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyRoomMembershipService } from '../src/modules/studyroom/study-room-membership.service.js';
import { StudyRoomWithdrawnSweeper } from '../src/modules/studyroom/study-room-withdrawn-sweeper.service.js';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';

// 탈퇴한 사용자가 남은 방 스위퍼를 실제 MongoDB로 확인한다.
// 명시적으로 지정한 로컬 DB에서만 실행한다(스터디룸 실DB 테스트와 같은 환경 변수).
const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);

describe.skipIf(!local)('탈퇴한 사용자가 남은 방 스위퍼 실제 MongoDB', () => {
  const suffix = randomBytes(8).toString('hex');
  const names = ['rooms', 'users'].map((name) => `test_sweeper_${name}_${suffix}`);
  const category = new Types.ObjectId();
  const gone = new Types.ObjectId(); // 탈퇴 완료(deletedAt)
  const gone2 = new Types.ObjectId();
  const gone3 = new Types.ObjectId();
  const leaving = new Types.ObjectId(); // 탈퇴 진행 중(withdrawingAt 만)
  const alive = new Types.ObjectId();
  const alive2 = new Types.ObjectId();
  let connection: mongoose.Connection;
  let rooms: mongoose.Model<StudyRoom>;
  let users: mongoose.Model<User>;
  let sweeper: StudyRoomWithdrawnSweeper;
  let sequence = 0;
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
    sweeper = new StudyRoomWithdrawnSweeper(
      rooms,
      users,
      new StudyRoomMembershipService(roomsService, gateway as never, live as never),
    );
  });
  beforeEach(async () => {
    calls = [];
    vi.clearAllMocks();
    await Promise.all([rooms.deleteMany({}), users.deleteMany({})]);
    const base = { deletedAt: null, withdrawingAt: null };
    await users.collection.insertMany([
      { _id: gone, nickname: '탈퇴1', email: 'g1@example.com', ...base, deletedAt: new Date() },
      { _id: gone2, nickname: '탈퇴2', email: 'g2@example.com', ...base, deletedAt: new Date() },
      { _id: gone3, nickname: '탈퇴3', email: 'g3@example.com', ...base, deletedAt: new Date() },
      {
        _id: leaving,
        nickname: '진행중',
        email: 'l@example.com',
        ...base,
        withdrawingAt: new Date(),
      },
      { _id: alive, nickname: '정상1', email: 'a1@example.com', ...base },
      { _id: alive2, nickname: '정상2', email: 'a2@example.com', ...base },
    ]);
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
    return rooms.create({
      title: `방${sequence}-${suffix}`,
      categoryId: category,
      hostId: members.find(([, isHost]) => isHost)![0],
      inviteCode: `S${String(sequence).padStart(5, '0')}`,
      isPublic: true,
      memberCount: members.length,
      maxCapacity: 6,
      members: members.map(([userId, isHost], index) => ({
        userId,
        role: isHost ? 'host' : 'member',
        status: 'joined',
        joinedAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
      })),
      ...over,
    });
  };
  const saved = (id: Types.ObjectId) => rooms.findById(id).lean().orFail();

  it('탈퇴 완료 사용자가 joined 로 남은 방에서 정리되고 memberCount 가 줄며, 소켓 · 연결도 정리한다', async () => {
    const created = await room([
      [alive, true],
      [gone, false],
    ]);
    await sweeper.sweep();
    const after = await saved(created._id);
    expect(after.memberCount).toBe(1);
    expect(after.hostId).toEqual(alive);
    expect(after.members.find((m) => m.userId.equals(gone))).toMatchObject({
      status: 'left',
      leaveReason: 'voluntary',
    });
    expect(after.members.find((m) => m.userId.equals(alive))?.status).toBe('joined');
    expect(calls).toEqual([
      `evict:${created._id}`,
      `disconnect:${created._id}`,
      `evict:${created._id}`,
      `notify:${created._id}`,
    ]);
  });

  it('그 사용자가 방장이면 먼저 입장한 다음 멤버가 방장이 된다', async () => {
    const created = await room([
      [gone, true],
      [alive, false],
      [alive2, false],
    ]);
    await sweeper.sweep();
    const after = await saved(created._id);
    expect(after.hostId).toEqual(alive);
    expect(after.memberCount).toBe(2);
    expect(after.closedAt ?? null).toBeNull();
  });

  it('혼자였으면 방이 닫히고 보관 기간이 시작된다', async () => {
    const created = await room([[gone, true]]);
    await sweeper.sweep();
    const after = await saved(created._id);
    expect(after.closedAt).toBeInstanceOf(Date);
    expect(after.deleteAfter).toBeInstanceOf(Date);
    expect(after.memberCount).toBe(0);
  });

  it('탈퇴 진행 중(withdrawingAt 만) · 정상 사용자 · 닫힌 방은 건드리지 않는다', async () => {
    const progressing = await room([
      [alive, true],
      [leaving, false],
    ]);
    const normal = await room([
      [alive, true],
      [alive2, false],
    ]);
    const closed = await room([[gone, true]], { closedAt: new Date(), memberCount: 0 });
    await sweeper.sweep();
    expect((await saved(progressing._id)).memberCount).toBe(2);
    expect(
      (await saved(progressing._id)).members.find((m) => m.userId.equals(leaving))?.status,
    ).toBe('joined');
    expect((await saved(normal._id)).memberCount).toBe(2);
    const afterClosed = await saved(closed._id);
    expect(afterClosed.members[0]?.status).toBe('joined');
    expect(afterClosed.memberCount).toBe(0);
    expect(calls).toEqual([]);
  });

  it('이미 나간 멤버(left)는 대상이 아니고, 다시 돌려도 같은 결과다', async () => {
    const created = await room([
      [alive, true],
      [gone, false],
    ]);
    await sweeper.sweep();
    calls.length = 0;
    await sweeper.sweep();
    expect(calls).toEqual([]);
    expect((await saved(created._id)).memberCount).toBe(1);
  });

  it('한 건이 실패해도 나머지는 처리되고, 다음 실행에서 실패한 건이 다시 처리된다', async () => {
    const first = await room([
      [alive, true],
      [gone, false],
    ]);
    const second = await room([
      [alive2, true],
      [gone2, false],
    ]);
    const warn = vi.spyOn((await import('@nestjs/common')).Logger.prototype, 'warn');
    warn.mockImplementation(() => {});
    try {
      live.disconnect.mockRejectedValueOnce(new Error('LiveKit 장애'));
      await sweeper.sweep();
      // 방 _id 순이라 first 가 먼저 실패하고 second 는 처리된다
      expect((await saved(first._id)).memberCount).toBe(2);
      expect((await saved(second._id)).memberCount).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      await sweeper.sweep();
      expect((await saved(first._id)).memberCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('최대 건수만큼만 처리하고 나머지는 다음 실행에서 처리한다', async () => {
    const created = await Promise.all([
      room([
        [alive, true],
        [gone, false],
      ]),
      room([
        [alive, true],
        [gone2, false],
      ]),
      room([
        [alive, true],
        [gone3, false],
      ]),
    ]);
    const counts = async () =>
      (await Promise.all(created.map((r) => saved(r._id)))).filter((r) => r.memberCount === 1)
        .length;
    await sweeper.sweep(2);
    expect(await counts()).toBe(2);
    await sweeper.sweep(2);
    expect(await counts()).toBe(3);
  });
});
