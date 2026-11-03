import { randomBytes } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { User, UserDocument } from '../auth/schemas/user.schema.js';
import { ROOM_MEMBER_ROLES, ROOM_MEMBER_STATUS } from './study-room.constants.js';
import { StudyRoom, StudyRoomDocument } from './schemas/study-room.schema.js';

// 입장 코드에 쓸 문자(헷갈리는 0/O, 1/I 제외)
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 6;

/** packages/shared의 StudyRoom */
export interface StudyRoomView {
  _id: string;
  title: string;
  categoryId: string;
  categoryName: string;
  hostId: string;
  isPublic: boolean;
  inviteCode: string;
  maxCapacity: number;
  memberCount: number;
  timerRule: Record<string, unknown> | null;
  members: {
    userId: string;
    nickname: string;
    avatarUrl: null;
    role: string;
    status: string;
  }[];
  createdAt: string;
  closedAt: string | null;
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
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  /** 스터디룸을 만들고, 만든 사람을 host 멤버로 넣습니다. */
  async create(
    hostId: string,
    input: {
      title: string;
      categoryName: string;
      isPublic: boolean;
      maxCapacity?: number;
    },
  ): Promise<StudyRoomView> {
    const inviteCode = await this.generateUniqueInviteCode();
    const hostObjectId = new Types.ObjectId(hostId);

    const room = await this.studyRoomModel.create({
      title: input.title,
      categoryName: input.categoryName,
      hostId: hostObjectId,
      isPublic: input.isPublic,
      inviteCode,
      ...(input.maxCapacity !== undefined ? { maxCapacity: input.maxCapacity } : {}),
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

    return this.toOneView(room);
  }

  /**
   * 공개 스터디룸 목록을 최신순으로 조회합니다. (p.75 "1. 스터디룸 탭 최초 화면")
   * 비공개방은 목록에 노출하지 않고 inviteCode로만 입장합니다.
   */
  async list(limit = 20, mineOf?: string): Promise<StudyRoomView[]> {
    // 과도한 요청을 막기 위해 최대 50개로 제한합니다.
    const safeLimit = Math.min(Math.max(limit, 1), 50);

    const rooms = await this.studyRoomModel
      .find({
        // 내 방 목록이 아니면 공개방만
        ...(mineOf
          ? {
              members: {
                $elemMatch: {
                  userId: new Types.ObjectId(mineOf),
                  status: ROOM_MEMBER_STATUS.JOINED,
                },
              },
            }
          : { isPublic: true }),
        closedAt: { $exists: false }, // 닫히지 않은 방만
      })
      .sort({ createdAt: -1 }) // 최신순
      .limit(safeLimit)
      .exec();

    return this.toViews(rooms, Boolean(mineOf));
  }

  /**
   * inviteCode로 스터디룸에 입장합니다. (p.75 "2. 스터디룸 코드로 입장")
   * 코드는 방의 "열쇠"이므로 공개/비공개 상관없이 코드만 맞으면 입장합니다.
   * (isPublic은 목록 노출 여부만 결정하고, 코드 입장 자체를 막지는 않습니다.)
   */
  async joinByCode(userId: string, inviteCode: string): Promise<StudyRoomView> {
    // 코드는 대문자로 생성되므로, 입력도 대문자로 맞춰 비교합니다.
    const code = inviteCode.toUpperCase();
    const userObjectId = new Types.ObjectId(userId);
    const now = new Date();
    // 정원 · 멤버 검사와 추가를 한 번의 갱신으로 해서 마지막 자리 동시 입장을 막습니다.
    const open = {
      inviteCode: code,
      closedAt: { $exists: false },
      $expr: { $lt: ['$memberCount', '$maxCapacity'] },
    };
    const joined =
      // 나갔던 멤버는 기록을 되살리고
      (await this.studyRoomModel.findOneAndUpdate(
        {
          ...open,
          members: {
            $elemMatch: {
              userId: userObjectId,
              status: { $ne: ROOM_MEMBER_STATUS.JOINED },
            },
          },
        },
        {
          $set: {
            'members.$.status': ROOM_MEMBER_STATUS.JOINED,
            'members.$.role': ROOM_MEMBER_ROLES.MEMBER,
            'members.$.joinedAt': now,
          },
          $unset: { 'members.$.leftAt': '' },
          $inc: { memberCount: 1 },
        },
        { new: true },
      )) ??
      // 처음이면 새로 넣습니다.
      (await this.studyRoomModel.findOneAndUpdate(
        { ...open, 'members.userId': { $ne: userObjectId } },
        {
          $push: {
            members: {
              userId: userObjectId,
              role: ROOM_MEMBER_ROLES.MEMBER,
              status: ROOM_MEMBER_STATUS.JOINED,
              joinedAt: now,
            },
          },
          $inc: { memberCount: 1 },
        },
        { new: true },
      ));
    if (joined) {
      return this.toOneView(joined);
    }

    // 갱신되지 않은 이유를 찾아 알립니다.
    const room = await this.studyRoomModel.findOne({ inviteCode: code });
    if (!room || room.closedAt) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸 코드입니다.',
      });
    }
    if (this.isJoined(room, userId)) {
      return this.toOneView(room); // 이미 참여 중
    }
    throw new ConflictException({
      code: 'ROOM_FULL',
      message: '스터디룸 정원이 가득 찼습니다.',
    });
  }

  /** 방 하나를 조회합니다. 참여 멤버만 볼 수 있습니다. */
  async get(userId: string, roomId: string): Promise<StudyRoomView> {
    const room = Types.ObjectId.isValid(roomId) ? await this.studyRoomModel.findById(roomId) : null;
    if (!room || room.closedAt) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }
    if (!this.isJoined(room, userId)) {
      throw new ForbiddenException({
        code: 'NOT_A_MEMBER',
        message: '참여 중인 스터디룸의 멤버만 조회할 수 있습니다.',
      });
    }
    return this.toOneView(room);
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

    const userObjectId = new Types.ObjectId(userId);
    const now = new Date();
    // 멤버 확인과 퇴장을 한 번에 해서 중복 요청이 인원을 두 번 줄이지 못하게 합니다.
    const room = await this.studyRoomModel.findOneAndUpdate(
      {
        _id: roomId,
        closedAt: { $exists: false },
        members: { $elemMatch: { userId: userObjectId, status: ROOM_MEMBER_STATUS.JOINED } },
      },
      {
        $set: { 'members.$.status': ROOM_MEMBER_STATUS.LEFT, 'members.$.leftAt': now },
        $inc: { memberCount: -1 },
      },
      { new: true },
    );
    if (!room) {
      const existing = await this.studyRoomModel.findById(roomId);
      if (!existing || existing.closedAt) {
        throw new NotFoundException({
          code: 'ROOM_NOT_FOUND',
          message: '존재하지 않는 스터디룸입니다.',
        });
      }
      // 참여 중이 아닌 사람은 나갈 수 없습니다.
      throw new ConflictException({
        code: 'NOT_A_MEMBER',
        message: '참여 중인 스터디룸이 아닙니다.',
      });
    }

    const wasHost = room.hostId.equals(userObjectId);

    // 남아 있는(joined) 다른 멤버들
    const remaining = room.members.filter((m) => m.status === ROOM_MEMBER_STATUS.JOINED);

    let closed = false;
    if (remaining.length === 0) {
      // 마지막 사람이 나가면 방을 닫습니다.
      room.closedAt = new Date();
      closed = true;
    } else if (wasHost) {
      // host가 나갔으면 가장 먼저 들어온 멤버에게 host를 위임합니다.
      const next = remaining.sort(
        (a, b) => (a.joinedAt?.getTime() ?? 0) - (b.joinedAt?.getTime() ?? 0),
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
  async getMembers(userId: string, roomId: string): Promise<StudyRoomMemberView[]> {
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
      (m) => m.userId.equals(userObjectId) && m.status === ROOM_MEMBER_STATUS.JOINED,
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

  private isJoined(room: StudyRoomDocument, userId: string): boolean {
    return room.members.some(
      (m) => m.userId.toString() === userId && m.status === ROOM_MEMBER_STATUS.JOINED,
    );
  }

  private async toOneView(room: StudyRoomDocument): Promise<StudyRoomView> {
    return (await this.toViews([room]))[0]!;
  }

  /** withMembers=false: 참여자가 아닌 사람에게 멤버 신원을 보이지 않습니다 (공개방 목록). */
  private async toViews(rooms: StudyRoomDocument[], withMembers = true): Promise<StudyRoomView[]> {
    const joined = (room: StudyRoomDocument) =>
      room.members.filter((m) => m.status === ROOM_MEMBER_STATUS.JOINED);
    const users = await this.userModel
      .find({
        _id: { $in: withMembers ? rooms.flatMap((r) => joined(r).map((m) => m.userId)) : [] },
      })
      .select('nickname');
    const nicknames = new Map(users.map((u) => [u._id.toString(), u.nickname]));
    return rooms.map((room) => ({
      _id: room._id.toString(),
      title: room.title,
      categoryId: room.categoryId?.toString() ?? '',
      categoryName: room.categoryName,
      hostId: room.hostId.toString(),
      isPublic: room.isPublic,
      inviteCode: room.inviteCode,
      maxCapacity: room.maxCapacity,
      memberCount: room.memberCount,
      timerRule: room.timerRule ?? null,
      members: (withMembers ? joined(room) : []).map((m) => ({
        userId: m.userId.toString(),
        nickname: nicknames.get(m.userId.toString()) ?? '알 수 없음',
        avatarUrl: null, // ponytail: users에 프로필 사진 필드가 생기면 채움
        role: m.role,
        status: m.status,
      })),
      createdAt: ((room as unknown as { createdAt?: Date }).createdAt ?? new Date()).toISOString(),
      closedAt: room.closedAt?.toISOString() ?? null,
    }));
  }
}
