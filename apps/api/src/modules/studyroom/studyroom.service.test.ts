import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { User } from '../auth/schemas/user.schema.js';
import { StudyRoom } from './schemas/study-room.schema.js';
import { StudyroomService } from './studyroom.service.js';

const hostId = new Types.ObjectId();
const userId = new Types.ObjectId();
const member = (id: Types.ObjectId, status = 'joined', role = 'member', joinedAt = new Date()) => ({
  userId: id,
  status,
  role,
  joinedAt,
  leftAt: undefined as Date | undefined,
});
const fakeRoom = (over: Record<string, unknown> = {}) => {
  const room = {
    _id: new Types.ObjectId(),
    title: '미적분',
    categoryName: '수학',
    hostId,
    isPublic: true,
    inviteCode: 'ABC234',
    maxCapacity: 6,
    memberCount: 1,
    members: [member(hostId, 'joined', 'host')],
    closedAt: undefined as Date | undefined,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    save: vi.fn(),
    $inc: vi.fn((_: string, by: number) => {
      room.memberCount += by;
    }),
    ...over,
  };
  return room;
};

describe('StudyroomService', () => {
  let service: StudyroomService;
  const model = {
    create: vi.fn(),
    exists: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
  };
  const userModel = { find: vi.fn() };
  const listChain = (rooms: unknown[]) => {
    const chain = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(rooms),
    };
    model.find.mockReturnValue(chain);
    return chain;
  };

  beforeEach(async () => {
    Object.values(model).forEach((fn) => fn.mockReset());
    model.exists.mockResolvedValue(null);
    userModel.find.mockReturnValue({
      select: vi.fn().mockResolvedValue([{ _id: hostId, nickname: '방장' }]),
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        StudyroomService,
        { provide: getModelToken(StudyRoom.name), useValue: model },
        { provide: getModelToken(User.name), useValue: userModel },
      ],
    }).compile();
    service = moduleRef.get(StudyroomService);
  });

  it('방을 만들면 만든 사람이 host이고 공용 계약 모양으로 돌려준다', async () => {
    model.create.mockImplementation((doc: Record<string, unknown>) => fakeRoom(doc));
    const view = await service.create(hostId.toString(), {
      title: '미적분',
      categoryName: '수학',
      isPublic: true,
    });
    expect(view._id).toBeTruthy();
    expect(view.categoryName).toBe('수학');
    expect(view.inviteCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(view.members).toEqual([
      {
        userId: hostId.toString(),
        nickname: '방장',
        avatarUrl: null,
        role: 'host',
        status: 'joined',
      },
    ]);
    expect(view.timerRule).toBeNull();
    expect(view.closedAt).toBeNull();
  });

  it('입장 코드가 겹치면 다시 만든다', async () => {
    model.exists.mockResolvedValueOnce({ _id: 'x' }).mockResolvedValueOnce(null);
    model.create.mockImplementation((doc: Record<string, unknown>) => fakeRoom(doc));
    await service.create(hostId.toString(), { title: 't', categoryName: 'c', isPublic: true });
    expect(model.exists).toHaveBeenCalledTimes(2);
  });

  describe('list', () => {
    it('기본은 닫히지 않은 공개방을 최대 50개까지', async () => {
      const chain = listChain([fakeRoom()]);
      const rooms = await service.list(999);
      expect(model.find.mock.calls[0]?.[0]).toEqual({
        isPublic: true,
        closedAt: { $exists: false },
      });
      expect(chain.limit).toHaveBeenCalledWith(50);
      expect(rooms).toHaveLength(1);
      expect(rooms[0]?.members).toEqual([]); // 공개방 목록에 멤버 신원을 넣지 않음
    });

    it('mine은 공개 여부와 무관하게 내가 참여 중인 방', async () => {
      listChain([]);
      await service.list(20, userId.toString());
      const filter = model.find.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(filter.isPublic).toBeUndefined();
      expect(filter.members).toEqual({ $elemMatch: { userId, status: 'joined' } });
    });
  });

  describe('joinByCode', () => {
    it('정원 조건을 건 한 번의 갱신으로 입장한다 (소문자 코드도 대문자로)', async () => {
      model.findOneAndUpdate
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(fakeRoom({ memberCount: 2 }));
      const view = await service.joinByCode(userId.toString(), 'abc234');
      expect(view.memberCount).toBe(2);
      const [filter, update] = model.findOneAndUpdate.mock.calls[1] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(filter.inviteCode).toBe('ABC234');
      expect(filter.$expr).toEqual({ $lt: ['$memberCount', '$maxCapacity'] });
      expect(update.$inc).toEqual({ memberCount: 1 });
    });

    it('나갔던 멤버는 기록을 되살린다', async () => {
      model.findOneAndUpdate.mockResolvedValueOnce(fakeRoom());
      await service.joinByCode(userId.toString(), 'ABC234');
      const update = model.findOneAndUpdate.mock.calls[0]?.[1] as { $set: object };
      expect(update.$set).toMatchObject({ 'members.$.status': 'joined' });
      expect(model.findOneAndUpdate).toHaveBeenCalledOnce();
    });

    it('갱신되지 않으면 이유를 구분한다', async () => {
      model.findOneAndUpdate.mockResolvedValue(null);
      model.findOne.mockResolvedValueOnce(null);
      await expect(service.joinByCode(userId.toString(), 'X')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      model.findOne.mockResolvedValueOnce(fakeRoom({ closedAt: new Date() }));
      await expect(service.joinByCode(userId.toString(), 'X')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      model.findOne.mockResolvedValueOnce(fakeRoom({ memberCount: 6 }));
      await expect(service.joinByCode(userId.toString(), 'X')).rejects.toBeInstanceOf(
        ConflictException,
      );
      model.findOne.mockResolvedValueOnce(fakeRoom());
      await expect(service.joinByCode(hostId.toString(), 'X')).resolves.toMatchObject({
        inviteCode: 'ABC234',
      });
    });
  });

  describe('get', () => {
    it('멤버에게만 보여 준다', async () => {
      model.findById.mockResolvedValue(fakeRoom());
      const id = new Types.ObjectId().toString();
      await expect(service.get(hostId.toString(), id)).resolves.toMatchObject({ title: '미적분' });
      await expect(service.get(userId.toString(), id)).rejects.toBeInstanceOf(ForbiddenException);
      model.findById.mockResolvedValue(null);
      await expect(service.get(hostId.toString(), id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('leave', () => {
    const roomId = new Types.ObjectId().toString();
    const left = (over: Record<string, unknown>) => {
      model.findOneAndUpdate.mockResolvedValue(fakeRoom(over));
    };

    it('갱신되지 않으면 없는 방과 멤버 아님을 구분한다', async () => {
      model.findOneAndUpdate.mockResolvedValue(null);
      model.findById.mockResolvedValue(null);
      await expect(service.leave(userId.toString(), roomId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      model.findById.mockResolvedValue(fakeRoom());
      await expect(service.leave(userId.toString(), roomId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('참여 중일 때만 한 번의 갱신으로 나가고 인원을 줄인다', async () => {
      left({ members: [member(hostId, 'joined', 'host'), member(userId, 'left')] });
      await expect(service.leave(userId.toString(), roomId)).resolves.toEqual({ closed: false });
      const [filter, update] = model.findOneAndUpdate.mock.calls[0] as [
        { members: unknown },
        { $inc: unknown },
      ];
      expect(filter.members).toEqual({ $elemMatch: { userId, status: 'joined' } });
      expect(update.$inc).toEqual({ memberCount: -1 });
    });

    it('host가 나가면 남은 멤버에게 넘긴다', async () => {
      const next = member(userId);
      const room = fakeRoom({ members: [member(hostId, 'left', 'host'), next] });
      model.findOneAndUpdate.mockResolvedValue(room);
      await service.leave(hostId.toString(), roomId);
      expect(room.hostId).toEqual(userId);
      expect(next.role).toBe('host');
    });

    it('마지막 사람이 나가면 방을 닫는다', async () => {
      const room = fakeRoom({ members: [member(hostId, 'left', 'host')] });
      model.findOneAndUpdate.mockResolvedValue(room);
      await expect(service.leave(hostId.toString(), roomId)).resolves.toEqual({ closed: true });
      expect(room.closedAt).toBeInstanceOf(Date);
    });
  });
});
