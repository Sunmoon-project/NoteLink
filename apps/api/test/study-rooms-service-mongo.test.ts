import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { Category, CategorySchema } from '../src/modules/content/schemas/category.schema.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';

const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);
if (process.env.REQUIRE_STUDYROOM_MONGO_TESTS === 'true' && !local) {
  throw new Error('REQUIRE_STUDYROOM_MONGO_TESTS=true requires a local STUDYROOM_TEST_MONGO_URI.');
}

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

    const first = await service.invite(String(host), created._id, [String(friend)]);
    const duplicate = await service.invite(String(host), created._id, [String(friend)]);
    expect(first.invitations).toEqual(duplicate.invitations);
    expect(first.invitations[0]?.invitationId).toBeTruthy();
    await rooms.updateOne(
      { _id: created._id, 'members.userId': friend },
      { $unset: { 'members.$.invitationId': 1 } },
    );
    const legacyPending = await service.invite(String(host), created._id, [String(friend)]);
    expect(legacyPending.invitations[0]?.invitationId).toBeTruthy();
    expect(legacyPending.invitations[0]?.invitationId).not.toBe(first.invitations[0]?.invitationId);

    const stored = await rooms.findById(created._id).lean().orFail();
    expect(stored.members.filter((member) => member.userId.equals(friend))).toHaveLength(1);
    expect(stored.members.find((member) => member.userId.equals(friend))).toMatchObject({
      role: 'member',
      status: 'invited',
    });
    expect(stored.memberCount).toBe(1);
  });
  it('자진 퇴장한 사용자의 기록을 재사용해 실제 MongoDB에서 다시 초대한다', async () => {
    const created = await service.create(String(host), {
      title: '재초대 테스트',
      categoryName: '수학',
      isPublic: true,
    });
    const userA = host.toHexString() < friend.toHexString() ? host : friend;
    const userB = userA === host ? friend : host;
    await friendships.create({ userA, userB, requesterId: host, status: 'accepted' });

    const first = await service.invite(String(host), created._id, [String(friend)]);
    await service.joinRoom(String(friend), created.inviteCode);
    await service.leaveRoom(String(friend), created._id);
    const reinvitation = await service.invite(String(host), created._id, [String(friend)]);

    const stored = await rooms.findById(created._id).lean().orFail();
    expect(stored.members.filter((member) => member.userId.equals(friend))).toHaveLength(1);
    expect(stored.members.find((member) => member.userId.equals(friend))).toMatchObject({
      role: 'member',
      status: 'invited',
      leaveReason: null,
      leftAt: null,
    });
    expect(reinvitation.invitations[0]?.invitationId).toBeTruthy();
    expect(reinvitation.invitations[0]?.invitationId).not.toBe(first.invitations[0]?.invitationId);
    expect(stored.memberCount).toBe(1);
  });
  describe('초대한 사람이 확인 뒤 방에서 빠지는 경우', () => {
    // 참여자(other)가 친구(friend)를 초대할 수 있는 방
    const roomWithInviter = async (title: string) => {
      const created = await service.create(String(host), {
        title,
        categoryName: '수학',
        isPublic: true,
      });
      await service.joinRoom(String(other), created.inviteCode);
      const userA = other.toHexString() < friend.toHexString() ? other : friend;
      const userB = userA === other ? friend : other;
      await friendships.create({ userA, userB, requesterId: other, status: 'accepted' });
      return created;
    };
    // 참여 확인 다음 단계(친구 확인)에서 초대한 사람을 실제 강퇴 · 퇴장 흐름으로 방에서 뺀다
    const inviteWhile = async (roomId: string, remove: () => Promise<unknown>) => {
      const count = friendships.countDocuments.bind(friendships);
      const spy = vi.spyOn(friendships, 'countDocuments').mockImplementationOnce((async (
        filter: never,
      ) => {
        await remove();
        return count(filter);
      }) as never);
      try {
        await expect(service.invite(String(other), roomId, [String(friend)])).rejects.toMatchObject(
          { status: 404, response: { code: 'ROOM_NOT_FOUND' } },
        );
      } finally {
        spy.mockRestore();
      }
      return rooms.findById(roomId).lean().orFail();
    };
    const removals = [
      ['강퇴', (roomId: string) => service.kickMember(String(host), roomId, String(other))],
      ['퇴장', (roomId: string) => service.leaveRoom(String(other), roomId)],
    ] as const;

    it.each(removals)('%s되면 새 초대를 저장하지 않는다', async (name, remove) => {
      const created = await roomWithInviter(`${name} 중 초대`);

      const stored = await inviteWhile(created._id, () => remove(created._id));

      expect(stored.members.some((member) => member.userId.equals(friend))).toBe(false);
      expect(stored.members.find((member) => member.userId.equals(other))?.status).not.toBe(
        'joined',
      );
    });

    it.each(removals)(
      '%s되면 초대 ID가 없는 기존 초대에 ID를 채우지 않는다',
      async (name, remove) => {
        const created = await roomWithInviter(`${name} 중 초대 ID 채우기`);
        await service.invite(String(other), created._id, [String(friend)]);
        await rooms.updateOne(
          { _id: created._id, 'members.userId': friend },
          { $unset: { 'members.$.invitationId': 1 } },
        );

        const stored = await inviteWhile(created._id, () => remove(created._id));

        const invited = stored.members.find((member) => member.userId.equals(friend));
        expect(invited?.status).toBe('invited');
        expect(invited?.invitationId ?? null).toBeNull();
      },
    );
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

  describe('회원 탈퇴가 시작된 사용자(withdrawingAt)', () => {
    const withdrawing = () =>
      users.updateOne({ _id: other }, { $set: { withdrawingAt: new Date() } });
    const body = (title: string) => ({ title, categoryName: '수학', isPublic: true });
    const gone = { status: 404, response: { code: 'NOT_FOUND' } };

    it('방을 만들 수 없고 입장도 거절된다(없는 사용자와 같은 404)', async () => {
      const created = await service.create(String(host), body('입장 대상'));
      const inviteCode = (await rooms.findById(created._id).lean().orFail()).inviteCode;
      await withdrawing();
      await expect(service.create(String(other), body('탈퇴 중 생성'))).rejects.toMatchObject(gone);
      expect(await rooms.countDocuments({ title: '탈퇴 중 생성' })).toBe(0);
      await expect(service.joinRoom(String(other), inviteCode)).rejects.toMatchObject(gone);
      const after = await rooms.findById(created._id).lean().orFail();
      expect(after.members.map((m) => String(m.userId))).toEqual([String(host)]);
      expect(after.memberCount).toBe(1);
    });

    it('입장: 확인을 통과한 뒤 저장 전에 탈퇴가 시작되면 저장 뒤 재확인에서 참여를 되돌리고 같은 오류를 던진다', async () => {
      const created = await service.create(String(host), body('입장 경합'));
      const inviteCode = (await rooms.findById(created._id).lean().orFail()).inviteCode;
      const original = rooms.findOneAndUpdate.bind(rooms) as (...args: unknown[]) => unknown;
      let started = false;
      vi.spyOn(rooms, 'findOneAndUpdate').mockImplementation(((...args: unknown[]) => {
        if (started) return original(...args);
        started = true; // 사용자 확인 뒤 · 첫 저장 직전에 탈퇴가 시작된다
        return withdrawing().then(() => original(...args));
      }) as never);
      const rollback = vi.fn((userId: string, roomId: string) => service.leaveRoom(userId, roomId));
      service.rollbackMembership = rollback;
      try {
        await expect(service.joinRoom(String(other), inviteCode)).rejects.toMatchObject(gone);
      } finally {
        service.rollbackMembership = undefined;
        vi.restoreAllMocks();
      }
      expect(started).toBe(true);
      expect(rollback).toHaveBeenCalledWith(String(other), String(created._id));
      const after = await rooms.findById(created._id).lean().orFail();
      expect(after.memberCount).toBe(1);
      expect(after.members.find((m) => m.userId.equals(other))).toMatchObject({
        status: 'left',
        leaveReason: 'voluntary',
      });
    });

    it('생성: 저장 전에 탈퇴가 시작되면 재확인에서 방을 되돌리고(혼자라 닫힘) 같은 오류를 던진다', async () => {
      const original = rooms.create.bind(rooms) as (...args: unknown[]) => unknown;
      vi.spyOn(rooms, 'create').mockImplementation(((...args: unknown[]) =>
        withdrawing().then(() => original(...args))) as never);
      try {
        await expect(service.create(String(other), body('생성 경합'))).rejects.toMatchObject(gone);
      } finally {
        vi.restoreAllMocks();
      }
      const room = await rooms.findOne({ title: '생성 경합' }).lean().orFail();
      expect(room.closedAt).toBeInstanceOf(Date);
      expect(room.memberCount).toBe(0);
    });
  });

  it('목록(내 방 · 추천)은 나간 · 강퇴된 · 초대만 받은 멤버를 내려주지 않고 참여 중인 멤버만 준다', async () => {
    const left = new Types.ObjectId();
    const kicked = new Types.ObjectId();
    const invited = new Types.ObjectId();
    await users.collection.insertMany(
      [left, kicked, invited].map((_id, i) => ({
        _id,
        nickname: `지난멤버${i}`,
        deletedAt: null,
      })),
    );
    const created = await service.create(String(host), {
      title: '멤버 상태 방',
      categoryName: '수학',
      isPublic: true,
    });
    await rooms.updateOne(
      { _id: created._id },
      {
        $push: {
          members: {
            $each: [
              { userId: other, role: 'member', status: 'joined' },
              { userId: left, role: 'member', status: 'left' },
              { userId: kicked, role: 'member', status: 'kicked' },
              { userId: invited, role: 'member', status: 'invited' },
            ],
          },
        },
      },
    );
    const joined = [String(host), String(other)];
    // 내 방 목록
    const mine = await service.list(String(host), 'mine');
    expect(mine[0]!.members.map((m) => m.userId)).toEqual(joined);
    expect(mine[0]!.members.every((m) => m.status === 'joined')).toBe(true);
    // 추천 목록(참여하지 않은 사람이 본다): 방장과 참여자만 보이고, 지난 멤버의 아이디 · 닉네임은 없다
    const recommended = await service.list(String(friend), 'recommended');
    expect(recommended[0]!.members.map((m) => m.userId)).toEqual(joined);
    expect(JSON.stringify(recommended)).not.toContain('지난멤버');
    // memberCount 등 다른 값은 그대로다
    expect(recommended[0]!.memberCount).toBe(1);
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

  describe('카테고리 여러 개 · 대상(learnerType) · 관심 분야 추천 (#550)', () => {
    const coding = new Types.ObjectId();
    const english = new Types.ObjectId();
    const hidden = new Types.ObjectId();
    beforeEach(async () => {
      await categories.collection.insertMany([
        { _id: coding, name: '코딩', ownerId: null, isActive: true, deletedAt: null },
        { _id: english, name: '영어', ownerId: null, isActive: true, deletedAt: null },
        { _id: hidden, name: '숨김', ownerId: null, isActive: false, deletedAt: null },
      ]);
      await users.updateOne({ _id: host }, { $set: { learnerType: 'university' } });
      await users.updateOne({ _id: other }, { $set: { learnerType: 'worker' } });
    });

    it('카테고리 id 여러 개로 만들면 순서대로 저장하고 첫 번째가 대표, 방장 learnerType을 복사한다', async () => {
      const created = await service.create(String(host), {
        title: '여러 분야',
        categoryIds: [String(english), String(coding), String(english).toUpperCase()],
        isPublic: true,
      });
      expect(created).toMatchObject({
        categoryId: String(english),
        categoryIds: [String(english), String(coding)],
        categoryNames: ['영어', '코딩'],
        categoryName: '영어',
        learnerType: 'university',
      });
      const stored = await rooms.findById(created._id).lean().orFail();
      expect(stored.categoryIds?.map(String)).toEqual([String(english), String(coding)]);
      expect(stored.learnerType).toBe('university');
      // 방장이 나중에 구분을 바꿔도 방 값은 그대로(만들 때 복사)
      await users.updateOne({ _id: host }, { $set: { learnerType: 'worker' } });
      expect((await service.getRoom(String(host), created._id)).learnerType).toBe('university');
    });

    it('비활성 · 없는 카테고리 id, 3개 넘는 카테고리, 카테고리 없음은 거절한다', async () => {
      for (const categoryIds of [
        [String(coding), String(hidden)],
        [String(new Types.ObjectId())],
        [String(coding), String(english), String(category), String(new Types.ObjectId())],
        [],
      ]) {
        await expect(
          service.create(String(host), { title: '거절', categoryIds, isPublic: true }),
        ).rejects.toMatchObject({ status: 400 });
      }
      await expect(
        service.create(String(host), { title: '거절', isPublic: true }),
      ).rejects.toMatchObject({ status: 400 });
      expect(await rooms.countDocuments()).toBe(0);
    });

    it('구 앱의 categoryName 요청도 받아 categoryIds 한 개로 저장한다', async () => {
      const created = await service.create(String(host), {
        title: '이름으로',
        categoryName: '코딩',
        isPublic: true,
      });
      expect(created).toMatchObject({
        categoryIds: [String(coding)],
        categoryNames: ['코딩'],
        learnerType: 'university',
      });
    });

    it('예전 방(categoryIds · learnerType 없음)은 읽을 때 [categoryId] · 방장 값으로 보정한다', async () => {
      const legacy = new Types.ObjectId();
      await rooms.collection.insertOne({
        _id: legacy,
        title: '예전 방',
        categoryId: category,
        hostId: other,
        isPublic: true,
        inviteCode: 'OLD001',
        maxCapacity: 6,
        memberCount: 1,
        members: [{ _id: new Types.ObjectId(), userId: other, role: 'host', status: 'joined' }],
        closedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const expected = {
        categoryId: String(category),
        categoryIds: [String(category)],
        categoryNames: ['수학'],
        learnerType: 'worker',
      };
      expect((await service.list(String(host), 'recommended'))[0]).toMatchObject(expected);
      expect((await service.list(String(other), 'mine'))[0]).toMatchObject(expected);
      expect(await service.getRoom(String(other), String(legacy))).toMatchObject(expected);
      // 방장이 구분을 정하지 않았거나 탈퇴했으면 null
      await users.updateOne({ _id: other }, { $set: { learnerType: null } });
      expect((await service.list(String(other), 'mine'))[0]!.learnerType).toBeNull();
    });

    it('추천은 내 관심 분야와 겹치는 방을 먼저, 나머지는 최신순으로 주고 개수 제한을 지킨다', async () => {
      await users.updateOne({ _id: friend }, { $set: { interestCategoryIds: [coding] } });
      const make = (title: string, ids: Types.ObjectId[]) =>
        service.create(String(other), {
          title,
          categoryIds: ids.map(String),
          isPublic: true,
        });
      const oldMatch = await make('예전 코딩', [english, coding]);
      const plain1 = await make('영어만', [english]);
      const newMatch = await make('새 코딩', [coding]);
      const plain2 = await make('수학만', [category]);
      const ids = (list: { _id: string }[]) => list.map((room) => room._id);
      expect(ids(await service.list(String(friend), 'recommended'))).toEqual([
        newMatch._id,
        oldMatch._id,
        plain2._id,
        plain1._id,
      ]);
      expect(ids(await service.list(String(friend), 'recommended', 3))).toEqual([
        newMatch._id,
        oldMatch._id,
        plain2._id,
      ]);
      expect(ids(await service.list(String(friend), 'recommended', 1))).toEqual([newMatch._id]);
      // 관심 분야가 없으면 그냥 최신순
      expect(ids(await service.list(String(host), 'recommended'))).toEqual([
        plain2._id,
        newMatch._id,
        plain1._id,
        oldMatch._id,
      ]);
    });
  });
});
