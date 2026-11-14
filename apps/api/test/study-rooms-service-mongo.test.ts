import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { Category, CategorySchema } from '../src/modules/content/schemas/category.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';

const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);

describe.skipIf(!local)('스터디룸 생성·목록·상세 실제 MongoDB 서비스', () => {
  const suffix = randomBytes(8).toString('hex');
  const names = ['rooms', 'users', 'categories', 'friendships'].map(
    (name) => `test_study_${name}_${suffix}`,
  );
  const host = new Types.ObjectId();
  const other = new Types.ObjectId();
  const friend = new Types.ObjectId();
  const category = new Types.ObjectId();
  let connection: mongoose.Connection;
  let rooms: mongoose.Model<StudyRoom>;
  let users: mongoose.Model<User>;
  let categories: mongoose.Model<Category>;
  let friendships: mongoose.Model<Friendship>;
  let service: StudyRoomsService;

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri!, { serverSelectionTimeoutMS: 5000 })
      .asPromise();
    rooms = connection.model(StudyRoom.name, StudyRoomSchema, names[0]);
    users = connection.model(User.name, UserSchema, names[1]);
    categories = connection.model(Category.name, CategorySchema, names[2]);
    friendships = connection.model(Friendship.name, FriendshipSchema, names[3]);
    await rooms.init();
    service = new StudyRoomsService(rooms, users, categories, friendships);
  });
  beforeEach(async () => {
    await Promise.all([
      rooms.deleteMany({}),
      users.deleteMany({}),
      categories.deleteMany({}),
      friendships.deleteMany({}),
    ]);
    await users.collection.insertMany([
      { _id: host, nickname: '방장', deletedAt: null },
      { _id: other, nickname: '참여자', deletedAt: null },
      { _id: friend, nickname: '친구', deletedAt: null },
    ]);
    await categories.collection.insertOne({
      _id: category,
      name: '수학',
      isActive: true,
      deletedAt: null,
    });
  });

  it('참여 중인 사용자가 실제 친구를 초대하고 중복 요청은 같은 초대 상태로 유지한다', async () => {
    const created = await service.create(String(host), {
      title: '친구 초대',
      categoryName: '수학',
      isPublic: true,
    });
    const userA = host.toHexString() < friend.toHexString() ? host : friend;
    const userB = userA === host ? friend : host;
    await friendships.create({ userA, userB, requesterId: host, status: 'accepted' });

    await service.invite(String(host), created._id, [String(friend)]);
    await service.invite(String(host), created._id, [String(friend)]);

    const stored = await rooms.findById(created._id).lean().orFail();
    expect(stored.members.filter((member) => member.userId.equals(friend))).toHaveLength(1);
    expect(stored.members.find((member) => member.userId.equals(friend))).toMatchObject({
      role: 'member',
      status: 'invited',
    });
    expect(stored.memberCount).toBe(1);
  });
  afterAll(async () => {
    if (!connection) return;
    for (const name of names) await connection.dropCollection(name!).catch(() => {});
    await connection.close();
  });

  it('방을 만들고 호스트·공개 설정·기본 인원을 저장한다', async () => {
    const created = await service.create(String(host), {
      title: ' 공부 ',
      categoryName: ' 수학 ',
      isPublic: true,
    });
    expect(created).toMatchObject({
      title: '공부',
      categoryName: '수학',
      hostId: String(host),
      maxCapacity: 6,
      memberCount: 1,
    });
    expect(created.members).toEqual([
      { userId: String(host), nickname: '방장', role: 'host', status: 'joined' },
    ]);
    const stored = await rooms.findById(created._id).lean().orFail();
    expect(stored.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(stored.members[0]).toMatchObject({ role: 'host', status: 'joined' });
  });

  it('없는 사용자와 사용할 수 없는 카테고리는 생성하지 않는다', async () => {
    await expect(
      service.create(String(new Types.ObjectId()), {
        title: '방',
        categoryName: '수학',
        isPublic: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.create(String(host), { title: '방', categoryName: '없는 카테고리', isPublic: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await rooms.countDocuments()).toBe(0);
  });

  it('같은 이름의 방을 만들면 409 충돌을 반환하고 기존 방을 유지한다', async () => {
    const input = { title: '중복 방', categoryName: '수학', isPublic: true };
    const first = await service.create(String(host), input);
    await expect(
      service.create(String(other), { ...input, title: ' 중복 방 ' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'ROOM_TITLE_DUPLICATE', message: '이미 사용 중인 스터디룸 이름입니다.' },
    });
    expect(await rooms.countDocuments({ title: input.title })).toBe(1);
    expect(await rooms.exists({ _id: first._id })).toBeTruthy();
  });

  it('내 목록과 추천 목록은 참여 여부·공개 상태·종료 상태를 구분한다', async () => {
    const mine = await service.create(String(host), {
      title: '내 방',
      categoryName: '수학',
      isPublic: true,
    });
    const publicRoom = await service.create(String(other), {
      title: '추천 방',
      categoryName: '수학',
      isPublic: true,
    });
    await service.create(String(other), {
      title: '비공개 방',
      categoryName: '수학',
      isPublic: false,
    });
    const closed = await service.create(String(other), {
      title: '종료 방',
      categoryName: '수학',
      isPublic: true,
    });
    await rooms.updateOne({ _id: closed._id }, { $set: { closedAt: new Date() } });
    expect((await service.list(String(host), 'mine')).map((r) => r._id)).toEqual([mine._id]);
    expect((await service.list(String(host), 'recommended')).map((r) => r._id)).toEqual([
      publicRoom._id,
    ]);
    expect(await service.list(String(host), 'recommended', 1)).toHaveLength(1);
  });

  it('상세는 현재 참여자만 조회하며 퇴장한 멤버를 제외한다', async () => {
    const created = await service.create(String(host), {
      title: '상세',
      categoryName: '수학',
      isPublic: true,
    });
    await rooms.updateOne(
      { _id: created._id },
      { $push: { members: { userId: other, role: 'member', status: 'left' } } },
    );
    expect((await service.getRoom(String(host), created._id)).members).toEqual([
      { userId: String(host), nickname: '방장', role: 'host', status: 'joined' },
    ]);
    await expect(service.getRoom(String(other), created._id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.getRoom(String(host), 'invalid')).rejects.toMatchObject({ status: 404 });
    await rooms.updateOne({ _id: created._id }, { $set: { closedAt: new Date() } });
    await expect(service.getRoom(String(host), created._id)).rejects.toMatchObject({ status: 404 });
  });
});
