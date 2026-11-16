import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { Timetable } from '../calendar/schemas/timetable.schema.js';
import { StudyChatService } from './study-chat.service.js';

/** 공용 일정 격자: 9시부터 14칸(9 ~ 23시), 월요일부터 7일(앱 tools.tsx · 로컬 api schedule과 같다) */
export const SCHEDULE_START_HOUR = 9;
const SCHEDULE_HOURS = 14;
const DAY_NAMES = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];
/** 추천 시간대는 긴 것부터 이만큼 */
const MATCH_LIMIT = 5;

type ClassRow = { days: number[]; startTime: string; endTime: string };
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
    label: DAY_NAMES[r.col]!,
    start: hh(SCHEDULE_START_HOUR + r.from),
    end: hh(SCHEDULE_START_HOUR + r.to),
    ...(i === 0 ? { best: true } : {}),
  }));
  return { grid, startHour: SCHEDULE_START_HOUR, matches };
}

/** 스터디룸 공용 일정(GET /study-rooms/:id/schedule). 참여 중인 멤버만 볼 수 있다 */
@Injectable()
export class StudyRoomScheduleService {
  constructor(
    @InjectModel(Timetable.name) private readonly timetables: Model<Timetable>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly chat: StudyChatService,
  ) {}

  /** GET /study-rooms/:id/schedule */
  async schedule(roomId: string, userId: string) {
    const room = await this.chat.requireMember(roomId, userId);
    const ids = room.members.filter((m) => m.status === 'joined').map((m) => m.userId);
    const [people, tables] = await Promise.all([
      this.users.find({ _id: { $in: ids }, deletedAt: null }, { nickname: 1 }).lean(),
      this.timetables.find({ userId: { $in: ids } }, { userId: 1, classes: 1 }).lean(),
    ]);
    const nick = new Map(people.map((u) => [String(u._id), u.nickname ?? '알 수 없음']));
    const members = ids
      .filter((id) => nick.has(String(id)))
      .map((id) => ({ nickname: nick.get(String(id))!, emoji: '✏️' }));
    return {
      members,
      ...buildSchedule(
        // 탈퇴한 멤버의 시간표는 세지 않는다(목록에 보이는 멤버만)
        tables
          .filter((t) => nick.has(String(t.userId)))
          .map((t) => (t.classes ?? []) as ClassRow[]),
        members.length,
      ),
    };
  }
}
