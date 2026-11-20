import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';

import { NotificationService } from '../notification/notification.service.js';
import { addDays } from '../progress/week.js';
import { seoulDate } from '../session/study-time.js';
import { Todo } from './schemas/todo.schema.js';

/** 확인 간격 */
const SCAN_MS = 5 * 60_000;
/** 서울 08:00~10:00에만 보낸다(그사이 서버가 내려가 있었으면 그날은 건너뛴다) */
const WINDOW_START_MIN = 8 * 60;
const WINDOW_END_MIN = 10 * 60;
/** 한 번 확인에서 보는 최대 개수(남으면 다음 확인에서) */
const PAGE = 500;
/** 며칠 전에 알리는지 → 문구 */
const LEADS: Record<number, { label: string; body: string }> = {
  7: { label: 'D-7', body: '일주일 남았어요' },
  1: { label: 'D-1', body: '내일이에요' },
  0: { label: 'D-day', body: '오늘이에요' },
};

function seoulMinutes(now: Date): number {
  const seoul = new Date(now.getTime() + 9 * 3_600_000);
  return seoul.getUTCHours() * 60 + seoul.getUTCMinutes();
}

/**
 * D-day 리마인드(FR-10, #560): 끝내지 않은 D-day(todos.isDday)를 D-7 · D-1 · 당일 아침에 한 번씩 알린다.
 * 그날 보냈다는 표시(ddayRemindedOn = 서울 날짜)를 조건부로 먼저 써서, 서버가 여럿이어도 한 번만 보낸다.
 * ponytail: 표시를 쓴 뒤 보내다 실패하면 그날은 다시 보내지 않는다(재시도 없음). 놓치면 안 되면 복습 알림처럼 선점 · 재시도로
 */
@Injectable()
export class DdayRemindersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DdayRemindersService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectModel(Todo.name) private readonly todos: Model<Todo>,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    const tick = () =>
      void this.runOnce().catch((error: unknown) =>
        this.logger.warn(`D-day 리마인드 확인 실패: ${String(error)}`),
      );
    tick();
    this.timer = setInterval(tick, SCAN_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<void> {
    const minutes = seoulMinutes(now);
    if (minutes < WINDOW_START_MIN || minutes >= WINDOW_END_MIN) return;
    const today = seoulDate(now);
    const leadOf = new Map(Object.keys(LEADS).map((n) => [addDays(today, Number(n)), Number(n)]));
    const due = await this.todos
      .find(
        {
          isDday: true,
          done: false,
          dueDate: { $in: [...leadOf.keys()] },
          ddayRemindedOn: { $ne: today },
        },
        { userId: 1, content: 1, dueDate: 1 },
      )
      .limit(PAGE)
      .lean<{ _id: Types.ObjectId; userId: Types.ObjectId; content: string; dueDate: string }[]>();
    for (const todo of due) {
      // 먼저 표시한 서버만 보낸다. updatedAt은 사용자가 바꾼 시각이라 건드리지 않는다
      const claimed = await this.todos.updateOne(
        { _id: todo._id, ddayRemindedOn: { $ne: today } },
        { $set: { ddayRemindedOn: today } },
        { timestamps: false },
      );
      if (!claimed.modifiedCount) continue;
      const lead = LEADS[leadOf.get(todo.dueDate)!]!;
      await this.notifications.notify(
        {
          userIds: [todo.userId],
          category: 'study',
          type: 'dday-remind',
          title: `${lead.label} · ${todo.content}`,
          body: lead.body,
          data: { ddayId: String(todo._id), date: todo.dueDate },
          collapseId: `dday:${String(todo._id)}:${today}`,
        },
        now,
      );
    }
  }
}
