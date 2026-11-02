import { randomBytes } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { ROOM_MEMBER_ROLES, ROOM_MEMBER_STATUS } from './study-room.constants.js';
import { StudyRoom, StudyRoomDocument } from './schemas/study-room.schema.js';

// 입장 코드에 쓸 문자(헷갈리는 0/O, 1/I 제외)
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 6;

export interface StudyRoomView {
  id: string;
  title: string;
  categoryId: string;
  hostId: string;
  isPublic: boolean;
  inviteCode: string;
  maxCapacity: number;
  memberCount: number;
}

export interface StudyRoomMemberView {
  userId: string;
  role: string;
  joinedAt?: string;
}

@Injectable()
export class StudyroomService {
  constructor(
    @InjectModel(StudyRoom.name)
    private readonly studyRoomModel: Model<StudyRoomDocument>,
  ) {}

  /** 스터디룸을 만들고, 만든 사람을 host 멤버로 넣습니다. */
  async create(
    hostId: string,
    input: {
      title: string;
      categoryId: string;
      isPublic: boolean;
      maxCapacity?: number;
    },
  ): Promise<StudyRoomView> {
    const inviteCode = await this.generateUniqueInviteCode();
    const hostObjectId = new Types.ObjectId(hostId);

    const room = await this.studyRoomModel.create({
      title: input.title,
      categoryId: new Types.ObjectId(input.categoryId),
      hostId: hostObjectId,
      isPublic: input.isPublic,
      inviteCode,
      ...(input.maxCapacity !== undefined
        ? { maxCapacity: input.maxCapacity }
        : {}),
      memberCount: 1,
      members: [
        {
          userId: hostObjectId,
          role: ROOM_MEMBER_ROLES.HOST,
          status: ROOM_MEMBER_STATUS.JOINED,
          joinedAt: new Date(),
        },
      ],
    });

    return this.toView(room);
  }

  /**
   * 공개 스터디룸 목록을 최신순으로 조회합니다. (p.75 "1. 스터디룸 탭 최초 화면")
   * 비공개방은 목록에 노출하지 않고 inviteCode로만 입장합니다.
   */
  async list(limit = 20): Promise<StudyRoomView[]> {
    // 과도한 요청을 막기 위해 최대 50개로 제한합니다.
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    const rooms = await this.studyRoomModel
      .find({
        isPublic: true, // 공개방만
        closedAt: { $exists: false }, // 닫히지 않은 방만
      })
      .sort({ createdAt: -1 }) // 최신순
      .limit(safeLimit)
      .exec();

    return rooms.map((room) => this.toView(room));
  }

  /**
   * inviteCode로 스터디룸에 입장합니다. (p.75 "2. 스터디룸 코드로 입장")
   * 코드는 방의 "열쇠"이므로 공개/비공개 상관없이 코드만 맞으면 입장합니다.
   * (isPublic은 목록 노출 여부만 결정하고, 코드 입장 자체를 막지는 않습니다.)
   */
  async joinByCode(userId: string, inviteCode: string): Promise<StudyRoomView> {
    // 코드는 대문자로 생성되므로, 입력도 대문자로 맞춰 비교합니다.
    const room = await this.studyRoomModel.findOne({
      inviteCode: inviteCode.toUpperCase(),
    });

    // ① 코드에 해당하는 방이 없거나 이미 닫힌 방
    if (!room || room.closedAt) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸 코드입니다.',
      });
    }

    const userObjectId = new Types.ObjectId(userId);

    // ② 이미 참여 중이면(joined) 그냥 방 정보를 돌려줍니다(중복 입장 방지).
    const alreadyJoined = room.members.some(
      (m) =>
        m.userId.equals(userObjectId) &&
        m.status === ROOM_MEMBER_STATUS.JOINED,
    );
    if (alreadyJoined) {
      return this.toView(room);
    }

    // ③ 정원이 가득 찼으면 거부
    if (room.memberCount >= room.maxCapacity) {
      throw new ConflictException({
        code: 'ROOM_FULL',
        message: '스터디룸 정원이 가득 찼습니다.',
      });
    }

    // ④ 이전에 나갔던(left) 멤버면 그 기록을 되살리고, 처음이면 새로 추가합니다.
    const previous = room.members.find((m) => m.userId.equals(userObjectId));
    if (previous) {
      previous.status = ROOM_MEMBER_STATUS.JOINED;
      previous.role = ROOM_MEMBER_ROLES.MEMBER;
      previous.joinedAt = new Date();
      previous.leftAt = undefined;
    } else {
      room.members.push({
        userId: userObjectId,
        role: ROOM_MEMBER_ROLES.MEMBER,
        status: ROOM_MEMBER_STATUS.JOINED,
        joinedAt: new Date(),
      } as StudyRoom['members'][number]);
    }
    room.memberCount += 1;
    await room.save();

    // NOTE: ③+④는 두 사람이 마지막 한 자리에 동시 입장하면 둘 다 통과할 수 있는
    // 경쟁 조건이 이론상 있습니다. 트래픽이 커지면 findOneAndUpdate 원자적 갱신으로 교체하세요.

    return this.toView(room);
  }

  /**
   * 스터디룸에서 나갑니다. (p.81 "20. 채팅방 나가기")
   * - 일반 멤버: status를 left로 바꾸고 memberCount -1
   * - host가 나가고 남은 멤버가 있으면: 가장 먼저 들어온 멤버에게 host를 위임
   * - host가 나가고 혼자였으면: 방을 닫음(closedAt)
   */
  async leave(userId: string, roomId: string): Promise<{ closed: boolean }> {
    if (!Types.ObjectId.isValid(roomId)) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }

    const room = await this.studyRoomModel.findById(roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }

    const userObjectId = new Types.ObjectId(userId);
    const me = room.members.find(
      (m) =>
        m.userId.equals(userObjectId) &&
        m.status === ROOM_MEMBER_STATUS.JOINED,
    );

    // 참여 중이 아닌 사람은 나갈 수 없습니다.
    if (!me) {
      throw new ConflictException({
        code: 'NOT_A_MEMBER',
        message: '참여 중인 스터디룸이 아닙니다.',
      });
    }

    const wasHost = me.role === ROOM_MEMBER_ROLES.HOST;

    // 본인을 나간 상태로 표시
    me.status = ROOM_MEMBER_STATUS.LEFT;
    me.leftAt = new Date();
    room.memberCount = Math.max(room.memberCount - 1, 0);

    // 남아 있는(joined) 다른 멤버들
    const remaining = room.members.filter(
      (m) => m.status === ROOM_MEMBER_STATUS.JOINED,
    );

    let closed = false;
    if (remaining.length === 0) {
      // 마지막 사람이 나가면 방을 닫습니다.
      room.closedAt = new Date();
      closed = true;
    } else if (wasHost) {
      // host가 나갔으면 가장 먼저 들어온 멤버에게 host를 위임합니다.
      const next = remaining.sort(
        (a, b) =>
          (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0),
      )[0]!;
      next.role = ROOM_MEMBER_ROLES.HOST;
      room.hostId = next.userId;
    }

    await room.save();
    return { closed };
  }

  /**
   * 스터디룸의 현재 참여 멤버(joined) 목록을 돌려줍니다.
   * 신고 대상 선택(picker) 등에 쓰입니다. 요청자는 그 방 멤버여야 합니다.
   */
  async getMembers(
    userId: string,
    roomId: string,
  ): Promise<StudyRoomMemberView[]> {
    if (!Types.ObjectId.isValid(roomId)) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }

    const room = await this.studyRoomModel.findById(roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }

    const userObjectId = new Types.ObjectId(userId);
    const isMember = room.members.some(
      (m) =>
        m.userId.equals(userObjectId) &&
        m.status === ROOM_MEMBER_STATUS.JOINED,
    );
    if (!isMember) {
      throw new ForbiddenException({
        code: 'NOT_A_MEMBER',
        message: '참여 중인 스터디룸의 멤버만 조회할 수 있습니다.',
      });
    }

    return room.members
      .filter((m) => m.status === ROOM_MEMBER_STATUS.JOINED)
      .map((m) => ({
        userId: m.userId.toString(),
        role: m.role,
        joinedAt: m.joinedAt?.toISOString(),
      }));
  }

  /** 중복되지 않는 입장 코드를 만듭니다. */
  private async generateUniqueInviteCode(): Promise<string> {
    // 충돌 가능성은 매우 낮지만, 만약을 대비해 몇 번 재시도합니다.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = this.randomInviteCode();
      const exists = await this.studyRoomModel.exists({ inviteCode: code });
      if (!exists) {
        return code;
      }
    }
    throw new Error('입장 코드 생성에 실패했습니다. 다시 시도해 주세요.');
  }

  private randomInviteCode(): string {
    const bytes = randomBytes(INVITE_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
      code += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
    }
    return code;
  }

  private toView(room: StudyRoomDocument): StudyRoomView {
    return {
      id: room._id.toString(),
      title: room.title,
      categoryId: room.categoryId.toString(),
      hostId: room.hostId.toString(),
      isPublic: room.isPublic,
      inviteCode: room.inviteCode,
      maxCapacity: room.maxCapacity,
      memberCount: room.memberCount,
    };
  }
}
