import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { RefreshToken } from '../auth/schemas/refresh-token.schema.js';
import { User } from '../auth/schemas/user.schema.js';
import { TimetableShare } from '../calendar/schemas/timetable-share.schema.js';
import { Friendship } from '../social/schemas/friendship.schema.js';
import { Device } from './schemas/device.schema.js';
import type { ChangePlanDto, RegisterDeviceDto, UpdateStatusDto } from './dto/account.dto.js';
import { toAppUser } from '../auth/to-app-user.js';
import { ProgressService } from '../progress/progress.service.js';
import type { UpdateProfileDto } from './dto/update-profiile.dto.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly progress: ProgressService,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    @InjectModel(RefreshToken.name) private readonly refreshTokens: Model<RefreshToken>,
    @InjectModel(Friendship.name) private readonly friendships: Model<Friendship>,
    @InjectModel(TimetableShare.name) private readonly shares: Model<TimetableShare>,
  ) {}

  /** 탈퇴하지 않은 내 계정 id. 없으면 404 */
  private async activeId(userId: string): Promise<Types.ObjectId> {
    const id = isValidObjectId(userId) ? new Types.ObjectId(userId) : null;
    if (!id || !(await this.userModel.exists({ _id: id, deletedAt: null }))) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' });
    }
    return id;
  }

  /** 친구 목록 · 스터디룸에 보이는 내 상태 */
  async setStatus(userId: string, dto: UpdateStatusDto): Promise<void> {
    const id = await this.activeId(userId);
    await this.userModel.updateOne({ _id: id }, { $set: { status: dto.status } });
  }

  /**
   * 푸시 알림을 받을 기기를 등록한다. 같은 토큰이면 정보만 갱신하고, 다른 계정이 쓰던 토큰이면 이 계정으로 옮긴다
   * (한 기기에서 계정을 바꿔 로그인하면 이전 계정의 알림이 그 기기로 가지 않게).
   */
  async registerDevice(userId: string, dto: RegisterDeviceDto, now = new Date()): Promise<void> {
    const id = await this.activeId(userId);
    await this.devices.updateOne(
      { pushToken: dto.pushToken },
      { $set: { userId: id, platform: dto.platform, locale: dto.locale, lastSeenAt: now } },
      { upsert: true },
    );
  }

  /**
   * 요금제 바꾸기. 결제(앱 마켓 영수증 확인)가 아직 없어 유료 요금제(pro · max)는 받지 않는다 —
   * 받으면 결제 없이 올릴 수 있다. 무료로 내리기(해지)만 한다.
   */
  async changePlan(userId: string, dto: ChangePlanDto, now = new Date()) {
    const id = await this.activeId(userId);
    if (dto.tier !== 'free') {
      throw new HttpException(
        { code: 'PAYMENT_REQUIRED', message: '결제 연동이 준비되면 바꿀 수 있어요' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    await this.userModel.updateOne(
      { _id: id },
      {
        $set: {
          subscription: {
            tier: 'free',
            status: 'active',
            startedAt: now,
            currentPeriodEnd: now,
            autoRenew: false,
            updatedAt: now,
          },
        },
      },
    );
    return this.getMe(userId);
  }

  /**
   * 회원 탈퇴. 계정 문서는 남기되(기록 · 정산 대조용) 로그인 수단과 개인 정보를 지운다:
   * 이메일 · 비밀번호 · 소셜 연동을 비우고 닉네임을 바꿔 같은 이메일 · 닉네임으로 다시 가입할 수 있게 한다.
   * 모든 기기 로그인(refresh 토큰)을 끊고, 푸시 기기 · 친구 관계 · 시간표 공유를 지운다.
   */
  async withdraw(userId: string, now = new Date()): Promise<void> {
    const id = await this.activeId(userId);
    const done = await this.userModel.updateOne(
      { _id: id, deletedAt: null },
      {
        $set: {
          deletedAt: now,
          email: null,
          passwordHash: null,
          socialAccounts: [],
          nickname: `탈퇴-${id.toHexString()}`,
          status: 'offline',
        },
      },
    );
    // 동시에 두 번 눌렀으면 먼저 끝난 쪽이 정리한다
    if (done.modifiedCount === 0) return;
    await this.refreshTokens.updateMany({ userId: id, revokedAt: null }, { revokedAt: now });
    await this.devices.deleteMany({ userId: id });
    await this.friendships.deleteMany({ $or: [{ userA: id }, { userB: id }] });
    await this.shares.deleteMany({ $or: [{ ownerId: id }, { friendId: id }] });
  }

  async interestCategories() {
    const categories = await this.userModel.db
      .collection('categories')
      .find({ ownerId: null, isActive: true, deletedAt: null })
      .sort({ sortOrder: 1, _id: 1 })
      .toArray();
    return categories.map((category) => ({
      _id: String(category._id),
      name: category.name,
      parentId: category.parentId ? String(category.parentId) : null,
    }));
  }

  async getMe(userId: string) {
    if (!isValidObjectId(userId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '사용자를 찾을 수 없습니다.',
      });
    }
    const user = await this.userModel.findOne({
      _id: new Types.ObjectId(userId),
      deletedAt: null,
    });

    if (!user) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '사용자를 찾을 수 없습니다.',
      });
    }
    return toAppUser(user, await this.progress.streakDays(userId));
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (!isValidObjectId(userId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '사용자를 찾을 수 없습니다.',
      });
    }

    const changes: Record<string, unknown> = {};
    if (dto.nickname !== undefined) changes.nickname = dto.nickname;
    if (dto.learnerType !== undefined) changes.learnerType = dto.learnerType;
    if (dto.interestCategoryIds !== undefined) {
      // 같은 ID가 두 번 와도 한 번만 검사하고 저장한다 (개수 비교가 어긋나지 않게)
      // (대소문자만 다른 같은 ID도 합치려고 ObjectId 값 기준으로 비교한다)
      const categoryIds = [
        ...new Set(dto.interestCategoryIds.map((id) => new Types.ObjectId(id).toHexString())),
      ].map((hex) => new Types.ObjectId(hex));
      // interestCategories()와 같은 범위: 공용 카테고리(ownerId: null)만 허용한다
      const categoryCount = await this.userModel.db.collection('categories').countDocuments({
        _id: { $in: categoryIds },
        ownerId: null,
        isActive: true,
        deletedAt: null,
      });
      if (categoryCount !== categoryIds.length) {
        throw new BadRequestException({
          code: 'INVALID_CATEGORY',
          message: '사용할 수 없는 관심 분야가 있습니다.',
        });
      }
      changes.interestCategoryIds = categoryIds;
    }
    if (dto.settings !== undefined) {
      for (const [key, value] of Object.entries(dto.settings)) {
        if (value !== undefined) changes[`settings.${key}`] = value;
      }
    }
    if (!Object.keys(changes).length) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: '수정할 항목이 없습니다.' });
    }

    try {
      const user = await this.userModel.findOneAndUpdate(
        { _id: new Types.ObjectId(userId), deletedAt: null },
        {
          $set: changes,
        },
        { new: true, runValidators: true },
      );

      if (!user) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: '사용자를 찾을 수 없습니다.',
        });
      }

      return toAppUser(user, await this.progress.streakDays(userId));
    } catch (error) {
      // nickname에는 유일 인덱스가 있으므로 DB에서도 중복을 막아줌.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000 &&
        'keyPattern' in error &&
        typeof error.keyPattern === 'object' &&
        error.keyPattern !== null &&
        'nickname' in error.keyPattern
      ) {
        throw new ConflictException({
          code: 'NICKNAME_TAKEN',
          message: '이미 사용 중인 닉네임 입니다.',
        });
      }
      throw error;
    }
  }
}
