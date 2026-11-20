import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { TimetableShare } from '../calendar/schemas/timetable-share.schema.js';
import { Timetable } from '../calendar/schemas/timetable.schema.js';
import { Friendship } from '../social/schemas/friendship.schema.js';
import { StudyRoom } from './schemas/study-room.schema.js';
import { StudyChatService } from './study-chat.service.js';

/** 공용 일정 격자: 9시부터 14칸(9 ~ 23시), 월요일부터 7일(앱 tools.tsx · 로컬 api schedule과 같다) */
export const SCHEDULE_START_HOUR = 9;
const SCHEDULE_HOURS = 14;
const DAY_NAMES = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];
/** 추천 시간대는 긴 것부터 이만큼 */
const MATCH_LIMIT = 5;

type ClassRow = { days: number[]; startTime: string; endTime: string; subjectName?: string };
const minutes = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};
/** 칸(행 = 시간, 열 = 월~일)에 이 수업이 걸치는지 */
const busy = (c: ClassRow, row: number, col: number) => {
  const weekday = (col + 1) % 7; // 열 0 = 월요일(1), 열 6 = 일요일(0)
  const from = (SCHEDULE_START_HOUR + row) * 60;
  return c.days.includes(weekday) && minutes(c.startTime) < from + 60 && minutes(c.endTime) > from;
};
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * 멤버들의 시간표로 공용 일정 격자를 만든다. 0 비어 있음(혼자라 공통이 아님) · 1 누군가 수업 · 2 모두 빔(2명 이상).
 * 추천 시간대는 모두 빈 칸이 이어진 구간을 요일마다 모아 긴 것부터, 가장 긴 것에 best를 붙인다
 */
export function buildSchedule(timetables: ClassRow[][], memberCount: number) {
  const grid = Array.from({ length: SCHEDULE_HOURS }, (_, row) =>
    Array.from({ length: 7 }, (_, col) =>
      timetables.some((classes) => classes.some((c) => busy(c, row, col)))
        ? 1
        : memberCount >= 2
          ? 2
          : 0,
    ),
  );
  const runs: { col: number; from: number; to: number }[] = [];
  for (let col = 0; col < 7; col++) {
    let from = -1;
    for (let row = 0; row <= SCHEDULE_HOURS; row++) {
      const free = row < SCHEDULE_HOURS && grid[row]![col] === 2;
      if (free && from < 0) from = row;
      if (!free && from >= 0) {
        runs.push({ col, from, to: row });
        from = -1;
      }
    }
  }
  runs.sort((a, b) => b.to - b.from - (a.to - a.from) || a.col - b.col || a.from - b.from);
  const matches = runs.slice(0, MATCH_LIMIT).map((r, i) => ({
    day: DAY_NAMES[r.col]!,
    // 같은 요일에 구간이 여럿이어도 겹치지 않게(앱이 label을 목록 key로 쓴다)
    label: `${DAY_NAMES[r.col]!} ${hh(SCHEDULE_START_HOUR + r.from)}부터`,
    start: hh(SCHEDULE_START_HOUR + r.from),
    end: hh(SCHEDULE_START_HOUR + r.to),
    ...(i === 0 ? { best: true } : {}),
  }));
  return { grid, startHour: SCHEDULE_START_HOUR, matches };
}

/**
 * 스터디룸 공용 일정(GET /study-rooms/:id/schedule). 참여 중인 멤버만 볼 수 있다.
 * 멤버마다 바쁜 시간(blocks)은 방 멤버 모두에게 보이고, 일정 제목(title)은 나 자신이거나
 * 그 멤버가 나에게 시간표를 전체 공개(mode=full)로 공유했고 지금도 친구일 때만 준다(아니면 null)
 */
@Injectable()
export class StudyRoomScheduleService {
  constructor(
    @InjectModel(Timetable.name) private readonly timetables: Model<Timetable>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(TimetableShare.name) private readonly shares: Model<TimetableShare>,
    @InjectModel(Friendship.name) private readonly friendships: Model<Friendship>,
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    private readonly chat: StudyChatService,
  ) {}

  /** 이 멤버들 중 나에게 제목을 보여 줘도 되는 사람(나 · 전체 공개한 친구)의 id */
  private async titleOwners(viewer: Types.ObjectId, ids: Types.ObjectId[]) {
    const [full, friends] = await Promise.all([
      this.shares
        .find(
          { ownerId: { $in: ids }, friendId: viewer, mode: 'full' },
          { ownerId: 1, friendshipId: 1 },
        )
        .lean(),
      this.friendships
        .find(
          {
            status: 'accepted',
            $or: [
              { userA: viewer, userB: { $in: ids } },
              { userB: viewer, userA: { $in: ids } },
            ],
          },
          { userA: 1, userB: 1 },
        )
        .lean(),
    ]);
    // 멤버 → 지금 친구 관계 id
    const link = new Map(
      friends.map((f) => [String(f.userA.equals(viewer) ? f.userB : f.userA), f._id]),
    );
    return new Set([
      String(viewer),
      // 시간표 공유 규칙(timetable.service)과 같게: 관계 id가 없는 예전 공유이거나 지금 관계로 만든 공유만 유효
      ...full
        .filter((sh) => {
          const now = link.get(String(sh.ownerId));
          return !!now && (!sh.friendshipId || sh.friendshipId.equals(now));
        })
        .map((sh) => String(sh.ownerId)),
    ]);
  }

  /** GET /study-rooms/:id/schedule */
  async schedule(roomId: string, userId: string) {
    const room = await this.chat.requireMember(roomId, userId);
    const joined = room.members.filter((m) => m.status === 'joined');
    const ids = joined.map((m) => m.userId);
    // 이 방에서 시간을 숨긴 멤버: blocks도, 격자 · 추천 시간 계산에도 넣지 않는다(시간표가 없는 사람과 똑같이 —
    // 혼자 바쁜 칸이나 차집합으로 그 사람 시간을 알아낼 수 없게)
    const hiddenIds = new Set(
      joined.filter((m) => m.hideSchedule === true).map((m) => String(m.userId)),
    );
    const [people, tables, shown] = await Promise.all([
      this.users.find({ _id: { $in: ids }, deletedAt: null }, { nickname: 1 }).lean(),
      this.timetables.find({ userId: { $in: ids } }, { userId: 1, classes: 1 }).lean(),
      this.titleOwners(new Types.ObjectId(userId), ids),
    ]);
    const nick = new Map(people.map((u) => [String(u._id), u.nickname ?? '알 수 없음']));
    const classesOf = new Map(
      tables.map((t) => [String(t.userId), (t.classes ?? []) as ClassRow[]]),
    );
    const members = ids
      .filter((id) => nick.has(String(id)))
      .map((id) => ({
        id: String(id),
        nickname: nick.get(String(id))!,
        emoji: '✏️',
        hidden: hiddenIds.has(String(id)),
        blocks: (hiddenIds.has(String(id)) ? [] : (classesOf.get(String(id)) ?? [])).flatMap((c) =>
          c.days.map((d) => ({
            day: (d + 6) % 7, // 0 = 월요일(격자 열과 같다)
            start: c.startTime,
            end: c.endTime,
            title: (shown.has(String(id)) && c.subjectName) || null, // 빈 제목도 null
          })),
        ),
      }));
    return {
      members,
      ...buildSchedule(
        // 탈퇴한 멤버 · 시간을 숨긴 멤버의 시간표는 세지 않는다
        tables
          .filter((t) => nick.has(String(t.userId)) && !hiddenIds.has(String(t.userId)))
          .map((t) => (t.classes ?? []) as ClassRow[]),
        members.length,
      ),
    };
  }

  /** PATCH /study-rooms/:id/schedule/visibility — 이 방에서 내 수업 시간을 숨기거나 다시 보인다(내 줄만 바꾼다) */
  async setScheduleHidden(roomId: string, userId: string, hidden: boolean) {
    await this.chat.requireMember(roomId, userId);
    const done = await this.rooms.updateOne(
      {
        _id: new Types.ObjectId(roomId),
        closedAt: null,
        members: { $elemMatch: { userId: new Types.ObjectId(userId), status: 'joined' } },
      },
      { $set: { 'members.$.hideSchedule': hidden } },
    );
    if (done.matchedCount === 0)
      throw new NotFoundException({ code: 'NOT_FOUND', message: '스터디룸을 찾을 수 없습니다.' });
    return { hidden };
  }
}
