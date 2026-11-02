import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROOM_MEMBER_ROLES } from './study-room.constants.js';
import { StudyRoom } from './schemas/study-room.schema.js';
import { StudyroomService } from './studyroom.service.js';

function createStudyRoomModelMock() {
  const model = vi.fn();
  return Object.assign(model, {
    create: vi.fn(),
    exists: vi.fn(),
    findOne: vi.fn(),
    find: vi.fn(),
    findById: vi.fn(),
  });
}

describe('StudyroomService', () => {
  let service: StudyroomService;
  let model: ReturnType<typeof createStudyRoomModelMock>;

  const hostId = new Types.ObjectId().toString();
  const categoryId = new Types.ObjectId().toString();

  beforeEach(async () => {
    model = createStudyRoomModelMock();
    model.exists.mockResolvedValue(null); // inviteCode 충돌 없음

    const moduleRef = await Test.createTestingModule({
      providers: [
        StudyroomService,
        { provide: getModelToken(StudyRoom.name), useValue: model },
      ],
    }).compile();

    service = moduleRef.get(StudyroomService);
  });

  it('방을 만들고 만든 사람을 host 멤버로 넣는다', async () => {
    const roomId = new Types.ObjectId();
    // create가 받은 문서를 그대로 "저장된 문서"처럼 돌려줍니다.
    model.create.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ _id: roomId, ...doc }),
    );

    const result = await service.create(hostId, {
      title: '미적분 스터디',
      categoryId,
      isPublic: true,
    });

    const createArg = model.create.mock.calls[0]?.[0] as {
      title: string;
      hostId: Types.ObjectId;
      isPublic: boolean;
      inviteCode: string;
      memberCount: number;
      members: Array<{ role: string; userId: Types.ObjectId }>;
    };

    // 저장 직전 데이터 검증
    expect(createArg.title).toBe('미적분 스터디');
    expect(createArg.hostId.toString()).toBe(hostId);
    expect(createArg.isPublic).toBe(true);
    expect(createArg.memberCount).toBe(1);
    expect(createArg.members).toHaveLength(1);
    expect(createArg.members[0]!.role).toBe(ROOM_MEMBER_ROLES.HOST);
    expect(createArg.members[0]!.userId.toString()).toBe(hostId);

    // 입장 코드는 6자리로 생성됨
    expect(createArg.inviteCode).toHaveLength(6);

    // 반환 뷰 검증
    expect(result.id).toBe(roomId.toString());
    expect(result.title).toBe('미적분 스터디');
    expect(result.hostId).toBe(hostId);
  });

  it('maxCapacity를 주면 그 값으로, 안 주면 기본값(스키마)이 쓰인다', async () => {
    const roomId = new Types.ObjectId();
    model.create.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ _id: roomId, maxCapacity: 6, memberCount: 1, ...doc }),
    );

    await service.create(hostId, {
      title: '소수정예방',
      categoryId,
      isPublic: false,
      maxCapacity: 4,
    });

    const createArg = model.create.mock.calls[0]?.[0] as {
      maxCapacity?: number;
    };
    expect(createArg.maxCapacity).toBe(4);
  });

  it('입장 코드가 충돌하면 다시 생성한다', async () => {
    const roomId = new Types.ObjectId();
    // 첫 번째 코드는 이미 존재(충돌), 두 번째는 사용 가능
    model.exists
      .mockResolvedValueOnce({ _id: 'dup' })
      .mockResolvedValueOnce(null);
    model.create.mockImplementation((doc: Record<string, unknown>) =>
      Promise.resolve({ _id: roomId, ...doc }),
    );

    await service.create(hostId, {
      title: '재시도방',
      categoryId,
      isPublic: true,
    });

    expect(model.exists).toHaveBeenCalledTimes(2);
  });

  describe('joinByCode', () => {
    const userId = new Types.ObjectId().toString();

    // save()를 가진 가짜 room 문서를 만듭니다.
    function makeRoom(overrides: Record<string, unknown> = {}) {
      return {
        _id: new Types.ObjectId(),
        title: '테스트방',
        categoryId: new Types.ObjectId(),
        hostId: new Types.ObjectId(),
        isPublic: true,
        inviteCode: 'ABC123',
        maxCapacity: 6,
        memberCount: 1,
        members: [],
        closedAt: undefined,
        save: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it('없는 코드면 ROOM_NOT_FOUND', async () => {
      model.findOne.mockResolvedValue(null);
      await expect(service.joinByCode(userId, 'ZZZ999')).rejects.toMatchObject({
        response: { code: 'ROOM_NOT_FOUND' },
      });
    });

    it('닫힌 방이면 ROOM_NOT_FOUND', async () => {
      model.findOne.mockResolvedValue(makeRoom({ closedAt: new Date() }));
      await expect(service.joinByCode(userId, 'ABC123')).rejects.toMatchObject({
        response: { code: 'ROOM_NOT_FOUND' },
      });
    });

    it('정원이 꽉 찼으면 ROOM_FULL', async () => {
      const room = makeRoom({ memberCount: 6, maxCapacity: 6, members: [] });
      model.findOne.mockResolvedValue(room);
      await expect(service.joinByCode(userId, 'ABC123')).rejects.toMatchObject({
        response: { code: 'ROOM_FULL' },
      });
      expect(room.save).not.toHaveBeenCalled();
    });

    it('이미 참여 중이면 멤버를 추가하지 않고 방 정보를 반환한다', async () => {
      const room = makeRoom({
        memberCount: 2,
        members: [
          {
            userId: new Types.ObjectId(userId),
            role: ROOM_MEMBER_ROLES.MEMBER,
            status: 'joined',
          },
        ],
      });
      model.findOne.mockResolvedValue(room);

      const result = await service.joinByCode(userId, 'ABC123');
      expect(room.save).not.toHaveBeenCalled();
      expect(room.memberCount).toBe(2); // 안 늘어남
      expect(result.memberCount).toBe(2);
    });

    it('정상 입장하면 member로 추가되고 memberCount가 1 늘어난다', async () => {
      const room = makeRoom({ memberCount: 1, maxCapacity: 6, members: [] });
      model.findOne.mockResolvedValue(room);

      const result = await service.joinByCode(userId, 'ABC123');

      expect(room.save).toHaveBeenCalledOnce();
      expect(room.memberCount).toBe(2);
      expect(room.members).toHaveLength(1);
      const added = room.members[0] as unknown as { role: string; status: string };
      expect(added.role).toBe(ROOM_MEMBER_ROLES.MEMBER);
      expect(added.status).toBe('joined');
      expect(result.memberCount).toBe(2);
    });

    it('소문자 코드로 입장해도 대문자로 변환해 조회한다', async () => {
      const room = makeRoom();
      model.findOne.mockResolvedValue(room);

      await service.joinByCode(userId, 'abc123');

      expect(model.findOne).toHaveBeenCalledWith({ inviteCode: 'ABC123' });
    });
  });

  describe('list', () => {
    // find().sort().limit().exec() 체이닝을 흉내 내는 헬퍼
    function mockFindChain(result: unknown[]) {
      const chain = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(result),
      };
      model.find.mockReturnValue(chain);
      return chain;
    }

    it('공개방만, 닫히지 않은 방만 조회한다', async () => {
      const chain = mockFindChain([]);
      await service.list();

      expect(model.find).toHaveBeenCalledWith({
        isPublic: true,
        closedAt: { $exists: false },
      });
      expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 }); // 최신순
    });

    it('limit을 적용하고, 최대 50으로 제한한다', async () => {
      const chain = mockFindChain([]);
      await service.list(999); // 과도한 값

      expect(chain.limit).toHaveBeenCalledWith(50); // 50으로 깎임
    });

    it('기본값은 20이다', async () => {
      const chain = mockFindChain([]);
      await service.list();

      expect(chain.limit).toHaveBeenCalledWith(20);
    });

    it('조회 결과를 뷰로 변환해 돌려준다', async () => {
      const roomId = new Types.ObjectId();
      mockFindChain([
        {
          _id: roomId,
          title: '공개방',
          categoryId: new Types.ObjectId(),
          hostId: new Types.ObjectId(),
          isPublic: true,
          inviteCode: 'PUB123',
          maxCapacity: 6,
          memberCount: 3,
        },
      ]);

      const result = await service.list();
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(roomId.toString());
      expect(result[0]!.title).toBe('공개방');
      expect(result[0]!.memberCount).toBe(3);
    });
  });

  describe('leave', () => {
    const roomId = new Types.ObjectId().toString();
    const hostUser = new Types.ObjectId();
    const memberUser = new Types.ObjectId();

    function makeRoom(members: unknown[], overrides: Record<string, unknown> = {}) {
      return {
        _id: new Types.ObjectId(roomId),
        hostId: hostUser,
        memberCount: members.length,
        members,
        closedAt: undefined,
        save: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it('참여 중이 아니면 NOT_A_MEMBER', async () => {
      const room = makeRoom([
        { userId: hostUser, role: 'host', status: 'joined', joinedAt: new Date() },
      ]);
      model.findById.mockResolvedValue(room);

      await expect(
        service.leave(memberUser.toString(), roomId),
      ).rejects.toMatchObject({ response: { code: 'NOT_A_MEMBER' } });
    });

    it('없는 방이면 ROOM_NOT_FOUND', async () => {
      model.findById.mockResolvedValue(null);
      await expect(
        service.leave(memberUser.toString(), roomId),
      ).rejects.toMatchObject({ response: { code: 'ROOM_NOT_FOUND' } });
    });

    it('일반 멤버가 나가면 left로 바뀌고 memberCount가 준다', async () => {
      const member = {
        userId: memberUser,
        role: 'member',
        status: 'joined',
        joinedAt: new Date(),
      };
      const room = makeRoom([
        { userId: hostUser, role: 'host', status: 'joined', joinedAt: new Date() },
        member,
      ]);
      model.findById.mockResolvedValue(room);

      const result = await service.leave(memberUser.toString(), roomId);

      expect(member.status).toBe('left');
      expect(room.memberCount).toBe(1);
      expect(room.closedAt).toBeUndefined(); // 안 닫힘
      expect(result.closed).toBe(false);
    });

    it('host가 나가면 남은 멤버에게 host가 위임된다', async () => {
      const nextHost = {
        userId: memberUser,
        role: 'member',
        status: 'joined',
        joinedAt: new Date(),
      };
      const host = {
        userId: hostUser,
        role: 'host',
        status: 'joined',
        joinedAt: new Date(Date.now() - 10000),
      };
      const room = makeRoom([host, nextHost]);
      model.findById.mockResolvedValue(room);

      const result = await service.leave(hostUser.toString(), roomId);

      expect(host.status).toBe('left');
      expect(nextHost.role).toBe('host'); // 위임됨
      expect(room.hostId).toBe(nextHost.userId);
      expect(result.closed).toBe(false);
    });

    it('마지막 사람이 나가면 방이 닫힌다', async () => {
      const only = {
        userId: hostUser,
        role: 'host',
        status: 'joined',
        joinedAt: new Date(),
      };
      const room = makeRoom([only]);
      model.findById.mockResolvedValue(room);

      const result = await service.leave(hostUser.toString(), roomId);

      expect(only.status).toBe('left');
      expect(room.memberCount).toBe(0);
      expect(room.closedAt).toBeInstanceOf(Date); // 닫힘
      expect(result.closed).toBe(true);
    });
  });
});
