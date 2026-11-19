import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { StudyRoom } from './schemas/study-room.schema.js';
import { StudyRoomMembershipService } from './study-room-membership.service.js';

/** 탈퇴한 사용자가 남은 방을 찾는 간격 */
export const WITHDRAWN_SWEEP_INTERVAL_MS = 5 * 60_000;
/** 한 번에 정리하는 (방, 사용자) 최대 건수 */
export const WITHDRAWN_SWEEP_MAX = 100;

interface LeftoverMembership {
  roomId: Types.ObjectId;
  userId: Types.ObjectId;
}

/**
 * 탈퇴를 마쳤는데(users.deletedAt) 열린 방에 joined 로 남아 있는 참여를 주기적으로 정리한다. 탈퇴 요청이 방 정리에
 * 실패해 멈췄거나(그 요청은 deletedAt 을 쓰지 않으니 이 스위퍼의 대상이 아니다) 정리가 끝난 뒤 끼어든 참여가 남은 경우를 받쳐 주는 안전망이다.
 * 정리 대상을 따로 저장하지 않고 매번 DB 상태에서 다시 찾으므로, 실패해도 다음 주기에 다시 잡힌다.
 * withdrawingAt 만 있고 deletedAt 이 없는 사용자(탈퇴 진행 중)는 건드리지 않는다: 그 정리는 탈퇴 요청이 한다.
 * 서버가 여러 대여도 같은 건을 동시에 처리할 수 있지만 안전하다: leaveRoom 은 joined 일 때만 바꾸고 이미 나간 방이면 오류 없이
 * 끝나며, 소켓 해제 · 연결 종료 · 알림은 다시 해도 결과가 같다.
 * 서버가 켜질 때는 돌지 않고 주기마다만 돈다(ReportImageSweeper 와 같음)
 */
@Injectable()
export class StudyRoomWithdrawnSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StudyRoomWithdrawnSweeper.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly membership: StudyRoomMembershipService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.sweep(), WITHDRAWN_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 한 번 정리한다. 겹쳐 부르면 뒤의 호출은 바로 끝난다. 한 건이 실패해도 나머지는 계속한다 */
  async sweep(limit = WITHDRAWN_SWEEP_MAX): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const leftovers = await this.findLeftovers(limit);
      let failed = 0;
      for (const { roomId, userId } of leftovers) {
        try {
          await this.membership.leaveRoomForWithdrawal(String(userId), String(roomId));
        } catch (error) {
          failed += 1;
          this.logger.warn(
            `탈퇴한 사용자의 스터디룸 참여를 정리하지 못했어요(방 ${String(roomId)}, 사용자 ${String(userId)}): ${String(error)}`,
          );
        }
      }
      if (leftovers.length)
        this.logger.log(
          `탈퇴한 사용자의 스터디룸 참여 정리: 대상 ${leftovers.length} · 실패 ${failed}`,
        );
    } catch (error) {
      this.logger.warn(
        `탈퇴한 사용자의 스터디룸 참여를 찾지 못했어요. 다음 주기에 다시 합니다: ${String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** 열린 방에 joined 로 남은 멤버 중 deletedAt 이 있는 사용자만 (방 _id 순으로, 최대 limit 건) */
  private findLeftovers(limit: number): Promise<LeftoverMembership[]> {
    return this.rooms.aggregate<LeftoverMembership>([
      { $match: { closedAt: null, members: { $elemMatch: { status: 'joined' } } } },
      { $sort: { _id: 1 } },
      { $unwind: '$members' },
      { $match: { 'members.status': 'joined' } },
      {
        $lookup: {
          from: this.users.collection.name,
          localField: 'members.userId',
          foreignField: '_id',
          pipeline: [{ $match: { deletedAt: { $ne: null } } }, { $project: { _id: 1 } }],
          as: 'withdrawn',
        },
      },
      { $match: { 'withdrawn.0': { $exists: true } } },
      { $project: { _id: 0, roomId: '$_id', userId: '$members.userId' } },
      { $limit: limit },
    ]);
  }
}
