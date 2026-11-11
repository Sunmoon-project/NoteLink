import { randomInt } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { Category } from '../content/schemas/category.schema.js';
import { CreateStudyRoomDto } from './dto/create-study-room.dto.js';
import { StudyRoom } from './schemas/study-room.schema.js';

@Injectable()
export class StudyRoomsService {
  constructor(
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Category.name) private readonly categories: Model<Category>,
  ) {}

  async create(userId: string, input: CreateStudyRoomDto) {
    if (!isValidObjectId(userId)) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '다시 로그인해 주세요',
      });
    }
    const title = input.title.trim();
    const name = input.categoryName.trim();
    if (!title || !name) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '방 이름과 카테고리를 입력해 주세요.',
      });
    }
    const hostId = new Types.ObjectId(userId);
    const host = await this.users.findOne({ _id: hostId, deletedAt: null }).lean();
    if (!host)
      throw new NotFoundException({ code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' });
    const categories = await this.categories
      .find({ name, ownerId: null, isActive: true, deletedAt: null })
      .limit(2)
      .lean();
    if (categories.length !== 1) {
      throw new BadRequestException({
        code: 'INVALID_CATEGORY',
        message: '사용할 수 없는 카테고리입니다.',
      });
    }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 5; attempt++) {
      const inviteCode = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(
        '',
      );
      try {
        const room = await this.rooms.create({
          title,
          categoryId: categories[0]!._id,
          hostId,
          isPublic: input.isPublic,
          maxCapacity: input.maxCapacity ?? 6,
          memberCount: 1,
          inviteCode,
          members: [{ userId: hostId, role: 'host', status: 'joined', joinedAt: new Date() }],
        });
        return {
          _id: String(room._id),
          title: room.title,
          categoryId: String(room.categoryId),
          categoryName: name,
          hostId: userId,
          isPublic: room.isPublic,
          inviteCode: room.inviteCode,
          maxCapacity: room.maxCapacity,
          memberCount: room.memberCount,
          timerRule: null,
          members: [{ userId, nickname: host.nickname, role: 'host', status: 'joined' }],
          createdAt: (room as typeof room & { createdAt: Date }).createdAt.toISOString(),
          closedAt: null,
        };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 11000 &&
          'keyPattern' in error &&
          typeof error.keyPattern === 'object' &&
          error.keyPattern !== null &&
          'inviteCode' in error.keyPattern
        )
          continue;
        throw error;
      }
    }
    throw new Error('스터디룸 초대 코드 생성에 실패했습니다.');
  }

  async list(userId: string, kind: 'mine' | 'recommended', limit?: number) {
    if (!isValidObjectId(userId)) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '다시 로그인해 주세요',
      });
    }
    const member = { userId: new Types.ObjectId(userId), status: 'joined' };
    const filter =
      kind === 'mine'
        ? { closedAt: null, members: { $elemMatch: member } }
        : { closedAt: null, isPublic: true, members: { $not: { $elemMatch: member } } };
    const query = this.rooms.find(filter).sort({ _id: -1 });
    if (limit !== undefined || kind === 'recommended') query.limit(limit ?? 50);
    const rooms = await query.lean();
    const memberIds = rooms.flatMap((room) => room.members.map((member) => member.userId));
    const users = memberIds.length
      ? await this.users.find({ _id: { $in: memberIds }, deletedAt: null }, { nickname: 1 }).lean()
      : [];
    const nicknames = new Map(users.map((user) => [String(user._id), user.nickname]));
    return rooms.map((room) => ({
      _id: String(room._id),
      title: room.title,
      categoryId: String(room.categoryId),
      hostId: String(room.hostId),
      isPublic: room.isPublic,
      inviteCode: room.inviteCode,
      maxCapacity: room.maxCapacity,
      memberCount: room.memberCount,
      timerRule: room.timerRule ?? null,
      members: room.members.map((member) => ({
        userId: String(member.userId),
        nickname: nicknames.get(String(member.userId)) ?? '알 수 없는 사용자',
        role: member.role,
        status: member.status,
      })),
      createdAt: (room as typeof room & { createdAt: Date }).createdAt.toISOString(),
      closedAt: room.closedAt?.toISOString() ?? null,
    }));
  }

  async getRoom(userId: string, roomId: string) {
    if (!isValidObjectId(userId)) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '다시 로그인해 주세요',
      });
    }
    const notFound = () =>
      new NotFoundException({ code: 'NOT_FOUND', message: '스터디룸을 찾을 수 없습니다.' });
    if (!isValidObjectId(roomId)) throw notFound();
    const room = await this.rooms
      .findOne({
        _id: new Types.ObjectId(roomId),
        closedAt: null,
        members: { $elemMatch: { userId: new Types.ObjectId(userId), status: 'joined' } },
      })
      .lean();
    if (!room) throw notFound();
    const joined = room.members.filter((member) => member.status === 'joined');
    const users = await this.users
      .find(
        { _id: { $in: joined.map((member) => member.userId) }, deletedAt: null },
        { nickname: 1 },
      )
      .lean();
    const nicknames = new Map(users.map((user) => [String(user._id), user.nickname]));
    return {
      _id: String(room._id),
      title: room.title,
      categoryId: String(room.categoryId),
      hostId: String(room.hostId),
      isPublic: room.isPublic,
      inviteCode: room.inviteCode,
      maxCapacity: room.maxCapacity,
      memberCount: room.memberCount,
      timerRule: room.timerRule ?? null,
      members: joined.map((member) => ({
        userId: String(member.userId),
        nickname: nicknames.get(String(member.userId)) ?? '알 수 없는 사용자',
        role: member.role,
        status: member.status,
      })),
      createdAt: (room as typeof room & { createdAt: Date }).createdAt.toISOString(),
      closedAt: room.closedAt?.toISOString() ?? null,
    };
  }

  async joinRoom(userId: string, inviteCode: string) {
    if (!isValidObjectId(userId)) {
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '다시 로그인해 주세요',
      });
    }
    const memberId = new Types.ObjectId(userId);
    const user = await this.users.findOne({ _id: memberId, deletedAt: null }).lean();
    if (!user)
      throw new NotFoundException({ code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' });
    const code = inviteCode.trim().toUpperCase();
    const available = {
      inviteCode: code,
      closedAt: null,
      $expr: { $lt: ['$memberCount', '$maxCapacity'] },
    };
    const now = new Date();

    // 기존 자진 퇴장 기록이 있는 경우에는 배열 항목을 재사용한다.
    let room = await this.rooms.findOneAndUpdate(
      {
        ...available,
        $expr: {
          $and: [
            available.$expr,
            {
              $eq: [
                {
                  $size: {
                    $filter: {
                      input: '$members',
                      as: 'm',
                      cond: { $eq: ['$$m.userId', memberId] },
                    },
                  },
                },
                1,
              ],
            },
          ],
        },
        members: {
          $elemMatch: {
            userId: memberId,
            status: 'left',
            leaveReason: { $in: ['voluntary', null] },
          },
          $not: { $elemMatch: { userId: memberId, status: { $in: ['joined', 'kicked'] } } },
        },
      },
      {
        $set: {
          'members.$[member].status': 'joined',
          'members.$[member].joinedAt': now,
          'members.$[member].leftAt': null,
          'members.$[member].kickedAt': null,
          'members.$[member].leaveReason': null,
        },
        $inc: { memberCount: 1 },
      },
      { new: true, arrayFilters: [{ 'member.userId': memberId, 'member.status': 'left' }] },
    );

    // 방에 기록이 전혀 없는 사용자만 새 배열 항목을 추가한다.
    if (!room) {
      room = await this.rooms.findOneAndUpdate(
        {
          ...available,
          members: { $not: { $elemMatch: { userId: memberId } } },
        },
        {
          $push: { members: { userId: memberId, role: 'member', status: 'joined', joinedAt: now } },
          $inc: { memberCount: 1 },
        },
        { new: true, runValidators: true },
      );
    }
    if (room) return this.getRoom(userId, String(room._id));

    const existing = await this.rooms.findOne({ inviteCode: code, closedAt: null }).lean();
    if (!existing)
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '스터디룸을 찾을 수 없습니다.',
      });
    const members = existing.members.filter((member) => member.userId.equals(memberId));
    if (
      members.some(
        (member) =>
          member.status === 'kicked' ||
          member.leaveReason === 'host_kick' ||
          member.leaveReason === 'report',
      )
    ) {
      throw new ForbiddenException({
        code: 'ROOM_BANNED',
        message: '퇴장 조치된 방에는 다시 참여할 수 없습니다.',
      });
    }
    if (members.some((member) => member.status === 'joined'))
      return this.getRoom(userId, String(existing._id));
    if (existing.memberCount >= existing.maxCapacity) {
      throw new ConflictException({ code: 'ROOM_FULL', message: '스터디룸 정원이 가득 찼습니다.' });
    }
    throw new ConflictException({
      code: 'ROOM_JOIN_FAILED',
      message: '참여 상태를 확인할 수 없습니다.',
    });
  }

  async leaveRoom(userId: string, roomId: string) {
    if (!isValidObjectId(userId))
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '다시 로그인해 주세요',
      });
    if (!isValidObjectId(roomId))
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '스터디룸을 찾을 수 없습니다.',
      });
    const memberId = new Types.ObjectId(userId);
    const result = await this.rooms.updateOne(
      {
        _id: new Types.ObjectId(roomId),
        closedAt: null,
        hostId: { $ne: memberId },
        memberCount: { $gt: 0 },
        members: { $elemMatch: { userId: memberId, status: 'joined' } },
        $expr: {
          $eq: [
            {
              $size: {
                $filter: { input: '$members', as: 'm', cond: { $eq: ['$$m.userId', memberId] } },
              },
            },
            1,
          ],
        },
      },
      {
        $set: {
          'members.$[member].status': 'left',
          'members.$[member].leaveReason': 'voluntary',
          'members.$[member].leftAt': new Date(),
        },
        $inc: { memberCount: -1 },
      },
      { arrayFilters: [{ 'member.userId': memberId, 'member.status': 'joined' }] },
    );
    if (!result.matchedCount)
      throw new ConflictException({
        code: 'ROOM_LEAVE_FAILED',
        message: '퇴장할 수 없는 방이거나 방장입니다.',
      });
  }

  async kickMember(hostUserId: string, roomId: string, targetUserId: string) {
    if (!isValidObjectId(hostUserId))
      throw new UnauthorizedException({
        code: 'AUTH_TOKEN_EXPIRED',
        message: '다시 로그인해 주세요',
      });
    if (!isValidObjectId(roomId) || !isValidObjectId(targetUserId))
      throw new NotFoundException({ code: 'NOT_FOUND', message: '대상을 찾을 수 없습니다.' });
    const hostId = new Types.ObjectId(hostUserId);
    const targetId = new Types.ObjectId(targetUserId);
    if (hostId.equals(targetId))
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '방장은 자신을 강퇴할 수 없습니다.',
      });
    const result = await this.rooms.updateOne(
      {
        _id: new Types.ObjectId(roomId),
        hostId,
        closedAt: null,
        memberCount: { $gt: 0 },
        members: { $elemMatch: { userId: targetId, status: 'joined' } },
        $expr: {
          $eq: [
            {
              $size: {
                $filter: { input: '$members', as: 'm', cond: { $eq: ['$$m.userId', targetId] } },
              },
            },
            1,
          ],
        },
      },
      {
        $set: {
          'members.$[member].status': 'kicked',
          'members.$[member].leaveReason': 'host_kick',
          'members.$[member].kickedAt': new Date(),
        },
        $inc: { memberCount: -1 },
      },
      { arrayFilters: [{ 'member.userId': targetId, 'member.status': 'joined' }] },
    );
    if (!result.matchedCount)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '방 또는 참여자를 찾을 수 없습니다.',
      });
  }
}
