import {
  ForbiddenException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';

const userId = new Types.ObjectId();
const roomId = new Types.ObjectId();
const query = (value: unknown) => ({ lean: async () => value });
const rooms = {
  findOneAndUpdate: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  exists: vi.fn(),
  findById: vi.fn(),
};
const users = { findOne: vi.fn(), find: vi.fn() };
const friendships = { countDocuments: vi.fn() };
let service: StudyRoomsService;
beforeEach(() => {
  vi.resetAllMocks();
  users.findOne.mockReturnValue(query({ _id: userId }));
  service = new StudyRoomsService(
    rooms as never,
    users as never,
    {} as never,
    friendships as never,
  );
  vi.spyOn(service, 'getRoom').mockResolvedValue({ _id: String(roomId) } as never);
});

describe('스터디룸 퇴장', () => {
  it('방장이 퇴장하면 원자적 갱신으로 남은 참가자에게 방장을 위임한다', async () => {
    rooms.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    await expect(service.leaveRoom(String(userId), String(roomId))).resolves.toBeUndefined();
    expect(rooms.updateOne).toHaveBeenCalledTimes(2);
    expect(rooms.updateOne.mock.calls[1]![0]).toMatchObject({
      hostId: userId,
      memberCount: { $gt: 1 },
    });
    expect(Array.isArray(rooms.updateOne.mock.calls[1]![1])).toBe(true);
  });
  it('마지막 방장이 나가면 방을 닫고 퇴장 상태를 저장한다', async () => {
    rooms.updateOne
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 0 })
      .mockResolvedValueOnce({ matchedCount: 1 });
    await expect(service.leaveRoom(String(userId), String(roomId))).resolves.toBeUndefined();
    expect(rooms.updateOne.mock.calls[2]![0]).toMatchObject({ hostId: userId, memberCount: 1 });
    expect(rooms.updateOne.mock.calls[2]![1]).toMatchObject({
      $set: { closedAt: expect.any(Date), memberCount: 0, 'members.$[member].status': 'left' },
    });
  });
  it('자진 퇴장은 상태 변경과 인원 감소를 함께 수행한다', async () => {
    rooms.updateOne.mockResolvedValue({ matchedCount: 1 });
    await service.leaveRoom(String(userId), String(roomId));
    const [filter, update] = rooms.updateOne.mock.calls[0]!;
    expect(filter).toMatchObject({
      hostId: { $ne: userId },
      memberCount: { $gt: 0 },
      members: { $elemMatch: { userId, status: 'joined' } },
    });
    expect(update).toMatchObject({
      $set: { 'members.$[member].status': 'left', 'members.$[member].leaveReason': 'voluntary' },
      $inc: { memberCount: -1 },
    });
  });
  it('방장만 다른 참여자를 강퇴할 수 있도록 조건을 적용한다', async () => {
    const target = new Types.ObjectId();
    rooms.updateOne.mockResolvedValue({ matchedCount: 1 });
    await service.kickMember(String(userId), String(roomId), String(target));
    const [filter, update] = rooms.updateOne.mock.calls[0]!;
    expect(filter).toMatchObject({
      hostId: userId,
      members: { $elemMatch: { userId: target, status: 'joined' } },
    });
    expect(update).toMatchObject({
      $set: { 'members.$[member].status': 'kicked', 'members.$[member].leaveReason': 'host_kick' },
      $inc: { memberCount: -1 },
    });
    await expect(
      service.kickMember(String(userId), String(roomId), String(userId)),
    ).rejects.toThrow();
  });
  it('이미 강퇴된 멤버의 라이브 종료를 방장만 재시도할 수 있다', async () => {
    const target = new Types.ObjectId();
    rooms.updateOne.mockResolvedValue({ matchedCount: 0 });
    rooms.exists.mockResolvedValueOnce({ _id: roomId }).mockResolvedValueOnce(null);
    await expect(
      service.kickMember(String(userId), String(roomId), String(target)),
    ).resolves.toBeUndefined();
    expect(rooms.exists).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: userId,
        members: { $elemMatch: { userId: target, status: 'kicked', leaveReason: 'host_kick' } },
      }),
    );
    await expect(
      service.kickMember(String(userId), String(roomId), String(target)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('스터디룸 코드 참여', () => {
  it('새 참여자를 원자적으로 추가하고 방 정보를 반환한다', async () => {
    rooms.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: roomId });
    await expect(service.joinRoom(String(userId), 'ABC123')).resolves.toEqual({
      _id: String(roomId),
    });
    const [filter, update] = rooms.findOneAndUpdate.mock.calls[2]!;
    expect(filter).toMatchObject({
      inviteCode: 'ABC123',
      closedAt: null,
      members: { $not: { $elemMatch: { userId } } },
      $expr: { $lt: [expect.objectContaining({ $size: expect.any(Object) }), '$maxCapacity'] },
    });
    expect(update).toMatchObject({
      $push: { members: { userId, status: 'joined', role: 'member' } },
      $inc: { memberCount: 1 },
    });
  });
  it('자진 퇴장 기록을 재사용하며 정원 검사를 함께 수행한다', async () => {
    rooms.findOneAndUpdate.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: roomId });
    await service.joinRoom(String(userId), 'ABC123');
    const [filter, update, options] = rooms.findOneAndUpdate.mock.calls[1]!;
    expect(filter.members.$elemMatch).toEqual({
      userId,
      status: 'left',
      leaveReason: { $in: ['voluntary', null] },
    });
    expect(update.$set['members.$[member].status']).toBe('joined');
    expect(update.$inc.memberCount).toBe(1);
    expect(options.arrayFilters).toEqual([{ 'member.userId': userId, 'member.status': 'left' }]);
  });
  it('초대된 멤버는 초대 기록을 참여 상태로 전환한다', async () => {
    rooms.findOneAndUpdate
      .mockResolvedValueOnce({ _id: roomId })
      .mockResolvedValueOnce({ _id: roomId });
    await service.joinRoom(String(userId), 'ABC123');
    const [filter, update, options] = rooms.findOneAndUpdate.mock.calls[0]!;
    expect(filter).toMatchObject({
      inviteCode: 'ABC123',
      members: { $elemMatch: { userId, status: 'invited' } },
    });
    expect(filter).not.toHaveProperty('$expr');
    expect(update).toMatchObject({
      $set: {
        'members.$[member].status': 'joined',
        'members.$[member].joinedAt': expect.any(Date),
        'members.$[member].invitedAt': null,
      },
      $inc: { memberCount: 1 },
    });
    expect(options.arrayFilters).toEqual([{ 'member.userId': userId, 'member.status': 'invited' }]);
  });
  it('강퇴되거나 신고 퇴장된 사용자는 재입장을 거부한다', async () => {
    rooms.findOneAndUpdate.mockResolvedValue(null);
    rooms.findOne.mockReturnValue(
      query({
        _id: roomId,
        memberCount: 1,
        maxCapacity: 6,
        members: [{ userId, status: 'kicked', leaveReason: 'report' }],
      }),
    );
    await expect(service.joinRoom(String(userId), 'ABC123')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it('이미 참여 중이면 중복 추가하지 않고 기존 방을 반환한다', async () => {
    rooms.findOneAndUpdate.mockResolvedValue(null);
    rooms.findOne.mockReturnValue(
      query({
        _id: roomId,
        memberCount: 6,
        maxCapacity: 6,
        members: [{ userId, status: 'joined' }],
      }),
    );
    await expect(service.joinRoom(String(userId), 'ABC123')).resolves.toEqual({
      _id: String(roomId),
    });
  });
  it('초대자가 예약한 자리를 코드 참여자가 먼저 차지하지 못한다', async () => {
    rooms.findOneAndUpdate.mockResolvedValue(null);
    rooms.findOne.mockReturnValue(
      query({
        _id: roomId,
        memberCount: 1,
        maxCapacity: 2,
        members: [
          { userId: new Types.ObjectId(), status: 'joined' },
          { userId: new Types.ObjectId(), status: 'invited' },
        ],
      }),
    );
    await expect(service.joinRoom(String(userId), 'ABC123')).rejects.toMatchObject({
      status: 409,
      response: { code: 'ROOM_FULL' },
    });
  });
  it('없는 방, 가득 찬 방, 유효하지 않은 사용자를 구분한다', async () => {
    rooms.findOneAndUpdate.mockResolvedValue(null);
    rooms.findOne
      .mockReturnValueOnce(query(null))
      .mockReturnValueOnce(query({ _id: roomId, memberCount: 6, maxCapacity: 6, members: [] }));
    await expect(service.joinRoom(String(userId), 'ABC123')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.joinRoom(String(userId), 'ABC123')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.joinRoom('invalid', 'ABC123')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('스터디룸 친구 초대', () => {
  it('참여 중인 사용자가 친구를 초대 상태로 저장한다', async () => {
    const friendId = new Types.ObjectId();
    rooms.findOne.mockReturnValue(
      query({ _id: roomId, title: '스터디룸', inviteCode: 'ABC123', maxCapacity: 6, members: [] }),
    );
    friendships.countDocuments.mockResolvedValue(1);
    users.find.mockReturnValue({ select: () => query([{ _id: friendId }]) });
    rooms.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(
      service.invite(String(userId), String(roomId), [String(friendId)]),
    ).resolves.toMatchObject({ room: { _id: String(roomId) }, targetUserIds: [String(friendId)] });
    const [filter, update] = rooms.updateOne.mock.calls[0]!;
    expect(filter).toMatchObject({ _id: roomId, closedAt: null });
    expect(update).toEqual([
      {
        $set: {
          members: expect.objectContaining({ $concatArrays: expect.any(Array) }),
        },
      },
    ]);
    expect(JSON.stringify(update)).toContain('invited');
  });

  it('자진 퇴장한 친구를 기존 멤버 기록을 재사용해 다시 초대한다', async () => {
    const friendId = new Types.ObjectId();
    rooms.findOne.mockReturnValue(
      query({
        _id: roomId,
        title: '스터디룸',
        inviteCode: 'ABC123',
        maxCapacity: 4,
        members: [
          { userId, status: 'joined' },
          { userId: friendId, status: 'left', leaveReason: 'voluntary' },
        ],
      }),
    );
    friendships.countDocuments.mockResolvedValue(1);
    users.find.mockReturnValue({ select: () => query([{ _id: friendId }]) });
    rooms.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(
      service.invite(String(userId), String(roomId), [String(friendId)]),
    ).resolves.toMatchObject({ targetUserIds: [String(friendId)] });
    const [filter, pipeline] = rooms.updateOne.mock.calls[0]!;
    expect(filter.$and).toContainEqual({
      members: {
        $elemMatch: {
          userId: friendId,
          status: 'left',
          leaveReason: { $in: ['voluntary', null] },
        },
      },
    });
    expect(JSON.stringify(pipeline)).toContain('leftAt');
    expect(JSON.stringify(pipeline)).toContain('invited');
    expect(JSON.stringify(pipeline)).not.toContain('$push');
  });

  it('남은 정원보다 많은 친구를 일괄 초대하면 일부도 초대 상태로 저장하지 않는다', async () => {
    const firstFriendId = new Types.ObjectId();
    const secondFriendId = new Types.ObjectId();
    rooms.findOne.mockReturnValue(
      query({
        _id: roomId,
        title: '스터디룸',
        inviteCode: 'ABC123',
        maxCapacity: 2,
        members: [{ userId, status: 'joined' }],
      }),
    );
    friendships.countDocuments.mockResolvedValue(2);
    users.find.mockReturnValue({
      select: () => query([{ _id: firstFriendId }, { _id: secondFriendId }]),
    });

    await expect(
      service.invite(String(userId), String(roomId), [String(firstFriendId), String(secondFriendId)]),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'ROOM_FULL' },
    });
    expect(rooms.updateOne).not.toHaveBeenCalled();
  });

  it('친구가 아닌 사용자와 방에 참여하지 않은 사용자의 초대를 거부한다', async () => {
    rooms.findOne.mockReturnValue(query({ members: [] }));
    friendships.countDocuments.mockResolvedValue(0);
    await expect(
      service.invite(String(userId), String(roomId), [String(new Types.ObjectId())]),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'ROOM_INVITE_NOT_FRIEND' },
    });

    rooms.findOne.mockReturnValue(query(null));
    await expect(
      service.invite(String(userId), String(roomId), [String(new Types.ObjectId())]),
    ).rejects.toMatchObject({ status: 404 });
  });
});
