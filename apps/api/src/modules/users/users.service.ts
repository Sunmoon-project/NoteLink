import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { TimetableShare } from '../calendar/schemas/timetable-share.schema.js';
import { Friendship } from '../social/schemas/friendship.schema.js';
import { Device } from './schemas/device.schema.js';
import type { ChangePlanDto, RegisterDeviceDto, UpdateStatusDto } from './dto/account.dto.js';
import { toAppUser } from '../auth/to-app-user.js';
import { TokenService } from '../auth/token.service.js';
import { ProgressService } from '../progress/progress.service.js';
import type { UpdateProfileDto } from './dto/update-profiile.dto.js';

@Injectable()
export class UsersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UsersService.name);
  /** 다시 할 탈퇴 계정 기기 정리(실패했을 때만 잡힌다). 하나만 둔다 */
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    private readonly progress: ProgressService,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly tokens: TokenService,
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
    // 탈퇴를 시작한 계정은 기기를 받지 않는다. 저장 뒤에도 다시 확인해서, 탈퇴 시작과 겹쳐도 남지 않게 한다:
    // 다시 확인이 통과했다면 저장은 탈퇴 시작보다 앞이라, 그 뒤에 도는 탈퇴의 기기 정리가 지운다
    const id = isValidObjectId(userId) ? new Types.ObjectId(userId) : null;
    const accepting = { _id: id, deletedAt: null, withdrawingAt: null };
    const notFound = () =>
      new NotFoundException({ code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' });
    if (!id || !(await this.userModel.exists(accepting))) throw notFound();
    await this.devices.updateOne(
      { pushToken: dto.pushToken },
      { $set: { userId: id, platform: dto.platform, locale: dto.locale, lastSeenAt: now } },
      { upsert: true },
    );
    let stillAccepting: boolean;
    try {
      stillAccepting = Boolean(await this.userModel.exists(accepting));
    } catch (error) {
      // 다시 확인하지 못했다: 그사이 탈퇴했을 수도 있으니 정리를 잡아 둔다(탈퇴한 계정의 기기만 지운다)
      this.scheduleSweep();
      throw error;
    }
    if (!stillAccepting) {
      // 저장한 기기를 지운다. 끝내 못 지우면 정리될 때까지 주기적으로 다시 한다(scheduleSweep)
      await this.retry(() =>
        this.devices.deleteMany({ pushToken: dto.pushToken, userId: id }),
      ).catch((error: unknown) => {
        this.logger.error(`탈퇴 중 등록된 기기를 지우지 못함(곧 다시 정리): ${String(error)}`);
        this.scheduleSweep();
      });
      throw notFound();
    }
  }

  /** 서버가 켜질 때 탈퇴한 계정에 남은 기기를 정리한다(이전 실행에서 못 지운 것). 시작을 늦추지 않게 기다리지 않는다 */
  onApplicationBootstrap(): void {
    this.scheduleSweep(0);
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  /**
   * 탈퇴 계정 기기 정리를 delayMs 뒤에 한다. 실패하면 간격을 두 배로(최대 1시간) 늘려 성공할 때까지 다시 한다.
   * 이미 잡혀 있으면 그대로 둔다(그 정리가 남은 기기를 모두 지운다)
   */
  private scheduleSweep(delayMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweepWithdrawnDevices().catch((error: unknown) => {
        this.logger.warn(`탈퇴 계정 기기 정리 실패(다시 시도): ${String(error)}`);
        this.scheduleSweep(Math.min(Math.max(delayMs * 2, 60_000), 3_600_000));
      });
    }, delayMs);
    this.sweepTimer.unref();
  }

  /**
   * 탈퇴한(또는 탈퇴를 시작한) 계정에 남은 푸시 기기를 지운다. 기기 등록이 탈퇴와 겹친 뒤 보상 삭제까지 실패한 경우를
   * 되살리는 경로다. 지운 개수를 돌려준다.
   */
  async sweepWithdrawnDevices(): Promise<number> {
    const owners = (await this.devices.distinct('userId')) as Types.ObjectId[];
    if (!owners.length) return 0;
    const gone = (await this.userModel.distinct('_id', {
      _id: { $in: owners },
      $or: [{ deletedAt: { $ne: null } }, { withdrawingAt: { $ne: null } }],
    })) as Types.ObjectId[];
    if (!gone.length) return 0;
    const result = await this.devices.deleteMany({ userId: { $in: gone } });
    return result.deletedCount;
  }

  /** 짧은 DB 오류를 넘기려고 세 번까지 해 본다 */
  private async retry<T>(task: () => Promise<T>, times = 3): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await task();
      } catch (error) {
        if (i >= times) throw error;
      }
    }
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
   * 모든 기기 로그인(access · refresh 토큰)을 끊고, 푸시 기기 · 친구 관계 · 시간표 공유를 지운다.
   *
   * 순서: 탈퇴 시작 표시(withdrawingAt, 새 기기를 막는다) → 정리 → 탈퇴 표시(deletedAt)와 개인 정보 지우기.
   * 탈퇴 표시를 마지막에 해서, 중간에 실패하면 계정이 아직 살아 있어 다시 로그인해 탈퇴를 다시 시도할 수 있다.
   * 탈퇴 표시 뒤에는 정리할 것이 남지 않는다(기기는 탈퇴 시작 뒤로 저장되지 않는다). 정리는 몇 번 되풀이해도 결과가 같다.
   */
  async withdraw(userId: string, now = new Date()): Promise<void> {
    const id = await this.activeId(userId);
    await this.userModel.updateOne(
      { _id: id, deletedAt: null, withdrawingAt: null },
      { $set: { withdrawingAt: now } },
    );
    await this.tokens.revokeAll(id, now);
    await this.devices.deleteMany({ userId: id });
    await this.friendships.deleteMany({ $or: [{ userA: id }, { userB: id }] });
    await this.shares.deleteMany({ $or: [{ ownerId: id }, { friendId: id }] });
    await this.userModel.updateOne(
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
