import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, type Friend, type FriendRequest } from '@notelink/shared';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../../auth/schemas/user.schema.js';
import { TimetableShare } from '../../calendar/schemas/timetable-share.schema.js';
import { Friendship } from '../schemas/friendship.schema.js';

/** 친구 기능의 오류 코드(앱은 문구를 그대로 보여 준다) */
export const FRIEND_ERRORS = {
  /** 나에게 친구 요청을 보냈다 */
  SELF: 'FRIEND_SELF',
  /** 이미 친구다 */
  ALREADY: 'FRIEND_ALREADY',
} as const;

type UserBrief = { _id: Types.ObjectId; nickname: string; status: string };
type Pair = { userA: Types.ObjectId; userB: Types.ObjectId };

/** 두 사람을 늘 같은 순서(id 작은 쪽이 userA)로 둔다. 한 쌍에 문서가 하나만 생기게 하는 유일 인덱스의 기준이다 */
export function pairOf(a: Types.ObjectId, b: Types.ObjectId): Pair {
  return a.toHexString() < b.toHexString() ? { userA: a, userB: b } : { userA: b, userB: a };
}

const isDuplicateKey = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000;

function objectId(id: string, what: string): Types.ObjectId {
  if (!isValidObjectId(id)) {
    throw new NotFoundException({
      code: ERROR_CODES.NOT_FOUND,
      message: `${what}을 찾을 수 없어요`,
    });
  }
  return new Types.ObjectId(id);
}

/**
 * 친구 찾기 · 요청 · 수락 · 거절 · 목록 · 삭제(FR-15). 한 쌍의 관계는 friendships 문서 하나로 둔다
 * (status: pending → accepted | rejected). 요청을 보낸 사람은 requesterId.
 */
@Injectable()
export class FriendsService {
  constructor(
    @InjectModel(Friendship.name) private readonly friendships: Model<Friendship>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(TimetableShare.name) private readonly shares: Model<TimetableShare>,
  ) {}

  /** 닉네임으로 사람 찾기(닉네임은 유일하므로 정확히 같은 한 명). 나 · 탈퇴한 사람은 빼고, 이미 친구여도 보여 준다 */
  async search(me: string, nickname: string): Promise<Friend[]> {
    const name = nickname.trim();
    if (!name) return [];
    const user = await this.users
      .findOne({ nickname: name, deletedAt: null })
      .select('_id nickname status')
      .lean<UserBrief>();
    if (!user || user._id.equals(me)) return [];
    return [toFriend(user._id, user)];
  }

  /**
   * 친구 요청. 상대가 먼저 나에게 요청해 둔 상태면 바로 친구가 된다(서로 요청).
   * 내가 보낸 요청이 이미 있으면 그대로 둔다(두 번 눌러도 하나). 거절됐던 쌍은 새 요청으로 되살린다.
   */
  async request(me: string, targetId: string, now = new Date()): Promise<void> {
    const meId = new Types.ObjectId(me);
    const target = objectId(targetId, '사용자');
    if (target.equals(meId)) {
      throw new BadRequestException({
        code: FRIEND_ERRORS.SELF,
        message: '나에게는 친구 요청을 보낼 수 없어요',
      });
    }
    const exists = await this.users.exists({ _id: target, deletedAt: null });
    if (!exists)
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: '사용자를 찾을 수 없어요',
      });

    const pair = pairOf(meId, target);
    const current = await this.friendships
      .findOne(pair)
      .lean<Friendship & { _id: Types.ObjectId }>();
    if (!current) {
      try {
        await this.friendships.create({
          ...pair,
          requesterId: meId,
          status: 'pending',
          requestedAt: now,
        });
        return;
      } catch (error) {
        // 같은 순간 상대도 요청했다(유일 인덱스). 상대 요청이 남은 상태로 아래를 다시 탄다
        if (!isDuplicateKey(error)) throw error;
        return this.request(me, targetId, now);
      }
    }
    if (current.status === 'accepted') {
      throw new ConflictException({ code: FRIEND_ERRORS.ALREADY, message: '이미 친구예요' });
    }
    if (current.status === 'pending') {
      if (current.requesterId.equals(meId)) return;
      // 상대가 먼저 보낸 요청이 있으면 수락한 것으로 본다
      // 요청자가 상대일 때만 수락한다: 그사이 상대 요청이 거절되고 내가 새로 보낸 요청으로 바뀌었으면, 내 요청을
      // 내가 수락하게 되므로(상대 응답 없이 친구가 됨) 빗나가게 해 지금 상태로 다시 처리한다
      const accepted = await this.friendships.updateOne(
        { _id: current._id, status: 'pending', requesterId: target },
        { $set: { status: 'accepted', acceptedAt: now } },
      );
      // 그사이 상태가 바뀌었으면(상대가 거절 · 끊기) 지금 상태로 다시 처리한다
      if (accepted.matchedCount === 0) return this.request(me, targetId, now);
      return;
    }
    // 거절 · 차단 이후의 새 요청: 거절은 되살리고, 차단은 조용히 받아 둔 척한다(차단 여부를 알리지 않는다)
    if (current.status === 'rejected') {
      const revived = await this.friendships.updateOne(
        { _id: current._id, status: 'rejected' },
        { $set: { status: 'pending', requesterId: meId, requestedAt: now, acceptedAt: null } },
      );
      // 양쪽이 동시에 다시 요청해 상대가 먼저 되살렸다 → 상대 요청이 있는 상태로 다시 처리해 친구가 된다
      if (revived.matchedCount === 0) return this.request(me, targetId, now);
    }
  }

  /** 나에게 온(내가 보내지 않은) 대기 중 요청. 최근 것부터 */
  async received(me: string): Promise<FriendRequest[]> {
    const meId = new Types.ObjectId(me);
    const docs = await this.friendships
      .find({
        status: 'pending',
        requesterId: { $ne: meId },
        $or: [{ userA: meId }, { userB: meId }],
      })
      .sort({ requestedAt: -1 })
      .lean<(Friendship & { _id: Types.ObjectId })[]>();
    const people = await this.briefs(docs.map((d) => d.requesterId));
    return docs.flatMap((d) => {
      const user = people.get(d.requesterId.toHexString());
      return user
        ? [
            {
              _id: d._id.toHexString(),
              requester: toFriend(d._id, user),
              requestedAt: d.requestedAt.toISOString(),
            },
          ]
        : [];
    });
  }

  /** 받은 요청을 수락하거나 거절한다. 내가 받은 대기 중 요청만 처리할 수 있다 */
  async respond(me: string, requestId: string, accept: boolean, now = new Date()): Promise<void> {
    const meId = new Types.ObjectId(me);
    const id = objectId(requestId, '친구 요청');
    const result = await this.friendships.updateOne(
      {
        _id: id,
        status: 'pending',
        requesterId: { $ne: meId },
        $or: [{ userA: meId }, { userB: meId }],
      },
      accept ? { $set: { status: 'accepted', acceptedAt: now } } : { $set: { status: 'rejected' } },
    );
    if (result.matchedCount === 0) {
      throw new NotFoundException({
        code: ERROR_CODES.NOT_FOUND,
        message: '친구 요청을 찾을 수 없어요',
      });
    }
  }

  /** 내 친구 목록(닉네임 순). `_id`는 친구 관계 id, `userId`는 상대 사용자 id */
  async friends(me: string): Promise<Friend[]> {
    const meId = new Types.ObjectId(me);
    const docs = await this.friendships
      .find({ status: 'accepted', $or: [{ userA: meId }, { userB: meId }] })
      .lean<(Friendship & { _id: Types.ObjectId })[]>();
    const other = (d: Pair) => (d.userA.equals(meId) ? d.userB : d.userA);
    const people = await this.briefs(docs.map(other));
    return docs
      .flatMap((d) => {
        const user = people.get(other(d).toHexString());
        return user ? [toFriend(d._id, user)] : [];
      })
      .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
  }

  /** 친구 끊기. 서로 주고받던 시간표 공유도 함께 정리한다(FR-15-06). 친구가 아니어도 오류 없이 끝낸다 */
  async remove(me: string, friendUserId: string): Promise<void> {
    const meId = new Types.ObjectId(me);
    const other = objectId(friendUserId, '친구');
    const ended = await this.friendships
      .findOneAndDelete({ ...pairOf(meId, other), status: 'accepted' })
      .lean<{ _id: Types.ObjectId }>();
    // 끊은 관계로 만든 공유만 지운다(예전 공유는 관계 id가 없어 null도 함께). 그사이 다시 친구가 되어 새로 공유했다면 새 관계의
    // id라 지워지지 않는다. 친구가 아니었으면 관계 id가 없는 예전 공유만 정리한다
    await this.shares.deleteMany({
      $or: [
        { ownerId: meId, friendId: other },
        { ownerId: other, friendId: meId },
      ],
      friendshipId: { $in: ended ? [ended._id, null] : [null] },
    });
  }

  /** 탈퇴하지 않은 사람들의 닉네임 · 상태 */
  private async briefs(ids: Types.ObjectId[]): Promise<Map<string, UserBrief>> {
    if (!ids.length) return new Map();
    const docs = await this.users
      .find({ _id: { $in: ids }, deletedAt: null })
      .select('_id nickname status')
      .lean<UserBrief[]>();
    return new Map(docs.map((u) => [u._id.toHexString(), u]));
  }
}

const STATUSES = ['active', 'busy', 'resting', 'offline'] as const;

function toFriend(id: Types.ObjectId, user: UserBrief): Friend {
  return {
    _id: id.toHexString(),
    userId: user._id.toHexString(),
    nickname: user.nickname,
    // 사용자 상태가 계약 밖 값이면(옛 데이터) 오프라인으로 보여 준다
    status: (STATUSES as readonly string[]).includes(user.status)
      ? (user.status as Friend['status'])
      : 'offline',
  };
}
