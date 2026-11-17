import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';

// 실제 MongoDB 검사는 명시적으로 지정한 로컬 DB에서만 실행한다.
const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);
describe.skipIf(!local)('로컬 MongoDB 동시 참여', () => {
  const collection = `test_studyroom_join_${randomBytes(8).toString('hex')}`;
  const ids = [new Types.ObjectId(), new Types.ObjectId()];
  let connection: mongoose.Connection;
  let model: mongoose.Model<StudyRoom>;
  let service: StudyRoomsService;

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri!, { serverSelectionTimeoutMS: 5000 })
      .asPromise();
    model = connection.model(StudyRoom.name, StudyRoomSchema, collection);
    await model.create({
      title: '임시 테스트',
      categoryId: new Types.ObjectId(),
      hostId: new Types.ObjectId(),
      inviteCode: 'TEST99',
      isPublic: true,
      memberCount: 1,
      maxCapacity: 2,
      members: [],
    });
    const users = { findOne: () => ({ lean: async () => ({ _id: ids[0] }) }) };
    service = new StudyRoomsService(model, users as never, {} as never, {} as never);
    vi.spyOn(service, 'getRoom').mockResolvedValue({} as never);
  });
  afterAll(async () => {
    if (connection) {
      await connection.dropCollection(collection).catch(() => {});
      await connection.close();
    }
  });
  it('마지막 한 자리에 두 사용자가 동시에 참여하면 한 명만 성공한다', async () => {
    const results = await Promise.allSettled(
      ids.map((id) => service.joinRoom(String(id), 'TEST99')),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const room = await model.findOne({ inviteCode: 'TEST99' }).lean().orFail();
    expect(room.memberCount).toBe(2);
    expect(room.members).toHaveLength(1);
  });
  it('자진 퇴장자는 기존 기록으로 재입장하고 방장 강퇴 후에는 재입장할 수 없다', async () => {
    const room = await model.create({
      title: '재입장 테스트',
      categoryId: new Types.ObjectId(),
      hostId: ids[0],
      inviteCode: 'TEST98',
      isPublic: false,
      memberCount: 1,
      maxCapacity: 3,
      members: [
        { userId: ids[0], role: 'host', status: 'joined' },
        { userId: ids[1], role: 'member', status: 'left', leaveReason: 'voluntary' },
      ],
    });
    await service.joinRoom(String(ids[1]), 'TEST98');
    let saved = await model.findById(room._id).lean().orFail();
    expect(saved.memberCount).toBe(2);
    expect(saved.members).toHaveLength(2);
    expect(saved.members[1]?.status).toBe('joined');
    await service.kickMember(String(ids[0]), String(room._id), String(ids[1]));
    await expect(service.joinRoom(String(ids[1]), 'TEST98')).rejects.toMatchObject({ status: 403 });
    saved = await model.findById(room._id).lean().orFail();
    expect(saved.memberCount).toBe(1);
    expect(saved.members[1]).toMatchObject({ status: 'kicked', leaveReason: 'host_kick' });
  });
  it('방장 퇴장 시 현재 참가자 중 가장 먼저 입장한 사람에게 방장을 넘긴다', async () => {
    const third = new Types.ObjectId();
    const room = await model.create({
      title: '방장 위임 테스트',
      categoryId: new Types.ObjectId(),
      hostId: ids[0],
      inviteCode: 'HOST01',
      isPublic: true,
      memberCount: 3,
      maxCapacity: 5,
      members: [
        { userId: ids[0], role: 'host', status: 'joined', joinedAt: new Date('2026-01-01') },
        { userId: third, role: 'member', status: 'joined', joinedAt: new Date('2026-01-03') },
        { userId: ids[1], role: 'member', status: 'joined', joinedAt: new Date('2026-01-02') },
      ],
    });
    await service.leaveRoom(String(ids[0]), String(room._id));
    const saved = await model.findById(room._id).lean().orFail();
    expect(String(saved.hostId)).toBe(String(ids[1]));
    expect(saved.memberCount).toBe(2);
    expect(saved.members[0]).toMatchObject({
      status: 'left',
      role: 'member',
      leaveReason: 'voluntary',
    });
    expect(saved.members[2]).toMatchObject({ status: 'joined', role: 'host' });
    await service.leaveRoom(String(ids[0]), String(room._id));
    expect((await model.findById(room._id).lean().orFail()).memberCount).toBe(2);
    await service.joinRoom(String(ids[0]), 'HOST01');
    const rejoined = await model.findById(room._id).lean().orFail();
    expect(rejoined.members[0]).toMatchObject({ status: 'joined', role: 'member' });
    expect(String(rejoined.hostId)).toBe(String(ids[1]));
    await service.kickMember(String(ids[1]), String(room._id), String(third));
    expect((await model.findById(room._id).lean().orFail()).members[1]).toMatchObject({
      status: 'kicked',
    });
  });
  it('마지막 참가자가 나가면 닫힌 방으로 남고 반복 퇴장은 안전하다', async () => {
    const room = await model.create({
      title: '마지막 퇴장',
      categoryId: new Types.ObjectId(),
      hostId: ids[0],
      inviteCode: 'LAST01',
      isPublic: true,
      memberCount: 1,
      maxCapacity: 5,
      members: [{ userId: ids[0], role: 'host', status: 'joined', joinedAt: new Date() }],
    });
    await service.leaveRoom(String(ids[0]), String(room._id));
    const closed = await model.findById(room._id).lean().orFail();
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.deleteAfter!.getTime() - closed.closedAt!.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(closed.memberCount).toBe(0);
    expect(closed.members[0]).toMatchObject({ status: 'left', leaveReason: 'voluntary' });
    await expect(service.leaveRoom(String(ids[0]), String(room._id))).resolves.toBeUndefined();
  });

  it('방장과 다른 참가자가 동시에 퇴장해도 남은 방장은 참여 상태다', async () => {
    const third = new Types.ObjectId();
    const room = await model.create({
      title: '방장 위임 동시성 테스트',
      categoryId: new Types.ObjectId(),
      hostId: ids[0],
      inviteCode: 'HOST02',
      isPublic: true,
      memberCount: 3,
      maxCapacity: 5,
      members: [
        { userId: ids[0], role: 'host', status: 'joined', joinedAt: new Date('2026-01-01') },
        { userId: ids[1], role: 'member', status: 'joined', joinedAt: new Date('2026-01-02') },
        { userId: third, role: 'member', status: 'joined', joinedAt: new Date('2026-01-03') },
      ],
    });
    await Promise.allSettled([
      service.leaveRoom(String(ids[0]), String(room._id)),
      service.leaveRoom(String(ids[1]), String(room._id)),
    ]);
    const saved = await model.findById(room._id).lean().orFail();
    const joined = saved.members.filter((member) => member.status === 'joined');
    expect(saved.memberCount).toBe(joined.length);
    expect(joined.filter((member) => member.role === 'host')).toHaveLength(1);
    expect(joined.find((member) => member.role === 'host')?.userId.equals(saved.hostId)).toBe(true);
  });
});
