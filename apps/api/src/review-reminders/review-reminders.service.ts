import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type Model, Types } from 'mongoose';

import { User } from '../modules/auth/schemas/user.schema.js';
import {
  ExpoPushService,
  type ExpoPushMessage,
} from '../modules/notification/expo-push.service.js';
import { NotificationService } from '../modules/notification/notification.service.js';
import { QuizSet } from '../modules/quiz/schemas/quiz-set.schema.js';
import { seoulDate } from '../modules/session/study-time.js';
import { Device } from '../modules/users/schemas/device.schema.js';
import {
  REVIEW_REMIND_LEASE_MS,
  REVIEW_REMIND_MAX_ATTEMPTS,
  REVIEW_REMIND_MAX_COUNT,
  REVIEW_REMIND_PAGE,
  REVIEW_REMIND_RECORD_DELAYS_MS,
  REVIEW_REMIND_RETRY_DELAYS_MS,
  REVIEW_REMIND_UNRECORDED_MAX,
  dayEnd,
  inRemindWindow,
  remindMessage,
} from './review-remind.js';
import { ReviewReminder } from './review-reminder.schema.js';

/** 확인하는 간격 */
const SCAN_MS = 60_000;
const EXPO_PUSH_TOKEN = /^(?:Expo|Exponent)PushToken\[[^\]]+\]$/;
/**
 * 다른 서버가 쥐고 있어 선점하지 못한 사용자를 다시 보기까지 기다리는 시간(한 번의 확인 간격). 그 서버가 끝냈으면 다음 확인의
 * 끝난 사용자 읽기에서 목록에서 빠지고, 죽었으면 선점이 만료된 뒤 첫 확인에서 이어받는다
 */
const CONTENDED_WAIT_MS = SCAN_MS;
/** 더 고르지 않는 최종 상태 */
const FINAL_STATES = ['sent', 'skipped', 'gave_up'];

/** 오늘 복습할 문제가 있는 사용자(하루 한 번 집계한 결과) */
interface DueUser {
  userId: Types.ObjectId;
  due: number;
}

/** 이 서버가 그날 처리하는 사용자 목록(메모리). 날짜가 바뀌거나 서버가 재시작하면 다시 집계한다 */
interface DayPlan {
  day: string;
  pending: DueUser[];
}

type Outcome = 'sent' | 'skipped' | 'retry';

/** 푸시는 보냈지만 sent 를 기록하지 못한 사용자(메모리 보관). 다음 확인에서 먼저 다시 쓴다 */
interface Unrecorded {
  user: DueUser;
  day: string;
  claimId: string;
  /** 선점한 시각: 이 시각 + 선점 만료(2분)가 지나면 다른 서버가 이어받았을 수 있어 다시 쓰지 않고 버린다 */
  claimedAt: Date;
}

/**
 * 오늘 복습할 문제가 있는 날 푸시를 보낸다(FR-37-08). 복습 날짜는 처리기(apps/ai srs.py)가 정해 quiz_sets 의
 * questions[].srs.dueAt(서울 0시를 UTC 로 둔 Date)에 저장하고, 오늘의 복습(today-review.service.ts · today.py)이 고르는 기준 —
 * 지우지 않은 ready 세트의 srs.state 'active' 이고 dueAt 이 내일 서울 0시 전인 문제(moved · mastered · stopped · flawed 는 빠진다) —
 * 과 같은 기준으로 센다. 알림에 적는 문제 수는 오늘의 복습 세트 크기(5)로 자른다.
 *
 * - 하루 한 번 집계: REVIEW_REMIND_TIME(19:00) 이후 첫 확인에서 한 번 집계해 대상 사용자를 메모리에 담는다. 오늘 푼 문제의
 *   dueAt 은 내일 0시 이후라 그날의 대상은 시작 때 거의 정해지므로, 그 뒤로는 목록만 처리한다(전체 세트를 1분마다 훑지 않는다).
 *   시각 전에는 DB를 읽지 않는다. 서버가 19:00 이후에 재시작하면 다시 집계하고, 이미 보낸 사용자는 review_reminders 로 걸러진다.
 * - 사용자마다 하루 한 번: review_reminders 의 (userId, day) 유니크 색인과 조건부 upsert 로 먼저 잡은 서버만 보낸다.
 *   선점한 서버가 죽으면 REVIEW_REMIND_LEASE_MS 뒤 다른 서버가 이어받는다(이때 기기에서는 collapseId 로 하나로 합쳐진다).
 * - 보내기 직전에 서울 날짜 · 내 선점 · 복습할 문제 수 · 오늘의 복습 세트 · 사용자 상태(탈퇴)를 다시 확인한다.
 *   날짜가 바뀌었으면 보내지 않는다.
 * - 무효 토큰 정리가 실패해도 발송은 성공으로 본다(재발송 금지). 발송이 전부 실패하면 REVIEW_REMIND_MAX_ATTEMPTS 까지 다시 시도한다.
 *   시도 횟수는 선점 응답(returnDocument: after)의 실제 값으로 판정한다.
 * - 발송 결과와 기록 오류는 따로 다룬다: 푸시를 보낸 뒤 sent 기록이 실패해도 선점을 풀지 않고 sent 만 다시 쓴다
 *   (0.2초 · 0.5초 뒤, 그래도 실패하면 메모리에 보관했다가 다음 확인 때 먼저 다시 쓴다. 선점 만료 뒤에는 버린다).
 * - 시도 횟수가 한도에 닿은 채 선점이 만료된 claimed 는 gave_up 으로 닫는다.
 * - 푸시를 받을 기기가 없는 사용자는 조용히 건너뛴다(skipped). 공부 알림을 껐거나 조용한 시간인 사용자도 그날은 건너뛴다(skipped).
 *
 * - 선점을 잃은 사용자는 목록에 남긴다: 선점을 가져간 서버가 보내기 전에 죽으면 집계가 하루 한 번이라 아무도 다시 보지 않기 때문이다.
 *   그 서버의 선점이 살아 있는 동안은 건드리지 않고 만료 정각에 이어받는다. 문서가 끝난 상태가 되거나 기다릴 시각이 날짜를
 *   넘으면 목록에서 지운다. 날짜가 바뀌면 목록과 대기 항목을 모두 비운다.
 *
 * 남는 한계(의도): 선점을 가져간 서버가 연속으로 죽는 경우 — 죽은 선점도 시도 횟수(REVIEW_REMIND_MAX_ATTEMPTS = 3)에 들어가므로, 서버
 * 두 대가 연속으로 보내기 전에 죽으면 세 번째 선점이 한도에 닿아 이어받지 못하고, 만료된 선점이 gave_up 으로 닫혀 그날 알림은
 * 가지 않는다(헛돌지는 않고 목록에서도 지워진다). 서버가 죽는 일이 드물고, 발송 실패 재시도 횟수를 늘리지 않으려고 한도를 3으로 두었다.
 * 남는 한계: 푸시를 보낸 뒤 sent 기록이 선점 만료(2분) 넘게 실패하거나 그 사이 서버가 죽으면, 다른 서버가 이어받아 같은 알림을
 * 한 번 더 보낼 수 있다(누락보다 중복을 택했다. 같은 collapseId 라 기기에서는 보통 한 알림으로 합쳐진다). 한도에 닿은 만료된
 * claimed 를 gave_up 으로 닫을 때도 푸시는 실제로 갔을 수 있다. 알림의 문제 수는 처리기가 같은 낱말 문제를 하나로 합치거나 결함
 * 문제를 검사해 빼는 것까지는 반영하지 못해 한두 개 어긋날 수 있다(결함 표시가 이미 있는 문제만 뺀다)
 */
@Injectable()
export class ReviewRemindersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReviewRemindersService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  /** 그날 처리할 사용자 목록(없으면 아직 집계하지 않음) */
  private plan: DayPlan | null = null;
  /** 다시 시도 · 선점 만료까지 기다리는 사용자: userId → 이 시각 전에는 건드리지 않는다 */
  private readonly waitUntil = new Map<string, number>();
  /** 푸시는 보냈지만 sent 를 기록하지 못한 사용자(오래된 것이 앞에 있다) */
  private readonly unrecorded = new Map<string, Unrecorded>();
  /** 기록하지 못한 sent 를 보관하는 최대 개수(테스트에서 바꿔 끼운다) */
  unrecordedLimit = REVIEW_REMIND_UNRECORDED_MAX;
  /** 기록을 다시 쓰기 전 기다림(테스트에서 실제로 기다리지 않게 바꿔 끼운다) */
  recordWait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSet>,
    @InjectModel(ReviewReminder.name) private readonly reminders: Model<ReviewReminder>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly push: ExpoPushService,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    void this.runOnce().catch((error: unknown) => this.logFailure(error));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.logFailure(error));
    }, SCAN_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.unrecorded.clear();
    this.waitUntil.clear();
    this.plan = null;
  }

  /** 테스트와 운영 스케줄러가 공유하는 한 번의 확인. 겹쳐 부르면 뒤의 호출은 바로 끝난다 */
  async runOnce(startedAt?: Date, clock?: () => Date): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tick = clock ?? (startedAt ? () => startedAt : () => new Date());
      // 지난 확인에서 기록하지 못한 sent 를 먼저 다시 쓴다(메모리만 보므로 시각과 상관없이)
      await this.flushUnrecorded(tick()).catch((e: unknown) => this.logFailure(e));

      const now = tick();
      const day = seoulDate(now);
      if (this.plan && this.plan.day !== day) this.resetPlan(); // 날짜가 바뀌면 그날 목록은 버린다
      if (!inRemindWindow(now, day)) return; // 시각 전(또는 자정 직후): DB를 읽지 않는다

      await this.closeExhausted(day, now).catch((e: unknown) => this.logFailure(e));
      if (!this.plan) {
        this.plan = { day, pending: await this.dueUsers(day) }; // 실패하면 던져서 다음 확인에서 다시 집계한다
      }
      await this.processPage(this.plan, tick);
    } finally {
      this.running = false;
    }
  }

  private resetPlan(): void {
    this.plan = null;
    this.waitUntil.clear();
  }

  /**
   * 오늘 복습할 문제가 있는 사용자를 모은다(하루 한 번). 오늘의 복습이 고르는 기준과 같다:
   * 지우지 않은 ready 세트(노트 있음)의 문제 중 srs.state 'active' 이고 dueAt 이 내일 서울 0시 전. 결함 표시(srs.flaw)가
   * 있는 문제는 오늘의 복습이 LLM 검사로 미루거나 뺄 수 있어 세지 않는다
   */
  private async dueUsers(day: string): Promise<DueUser[]> {
    const rows = await this.sets.aggregate<{ _id: Types.ObjectId; due: number }>(
      this.duePipeline(day),
    );
    return rows.map((r) => ({ userId: r._id, due: r.due }));
  }

  /** 한 사용자의 복습할 문제 수를 다시 센다(보내기 직전) */
  private async countDue(userId: Types.ObjectId, day: string): Promise<number> {
    const rows = await this.sets.aggregate<{ _id: Types.ObjectId; due: number }>(
      this.duePipeline(day, userId),
    );
    return rows[0]?.due ?? 0;
  }

  private duePipeline(day: string, ownerId?: Types.ObjectId) {
    const tomorrow = dayEnd(day);
    return [
      {
        $match: {
          ...(ownerId ? { ownerId } : {}),
          deletedAt: null,
          status: 'ready',
          materialId: { $ne: null },
          questions: { $elemMatch: { 'srs.state': 'active', 'srs.dueAt': { $lt: tomorrow } } },
        },
      },
      { $unwind: '$questions' },
      {
        $match: {
          'questions.srs.state': 'active',
          'questions.srs.dueAt': { $lt: tomorrow },
          'questions.srs.flaw': { $exists: false },
        },
      },
      { $group: { _id: '$ownerId', due: { $sum: 1 } } },
      ...(ownerId ? [] : [{ $sort: { _id: 1 as const } }]),
    ];
  }

  /** 대기 중인 사용자 중 시간이 된 REVIEW_REMIND_PAGE 명을 처리한다 */
  private async processPage(plan: DayPlan, tick: () => Date): Promise<void> {
    const nowMs = tick().getTime();
    const ready: DueUser[] = [];
    const keep: DueUser[] = [];
    for (const user of plan.pending) {
      const until = this.waitUntil.get(String(user.userId)) ?? 0;
      if (ready.length < REVIEW_REMIND_PAGE && until <= nowMs) ready.push(user);
      else keep.push(user);
    }
    if (!ready.length) return;

    // 이미 끝난 사용자(다른 서버가 보냈거나 서버 재시작 전에 보냄)는 선점하지 않고 목록에서 뺀다
    const finished = await this.reminders
      .find(
        {
          day: plan.day,
          userId: { $in: ready.map((u) => u.userId) },
          state: { $in: FINAL_STATES },
        },
        { userId: 1 },
      )
      .lean<{ userId: Types.ObjectId }[]>();
    const done = new Set(finished.map((f) => String(f.userId)));

    const stillPending: DueUser[] = [...keep];
    const end = dayEnd(plan.day).getTime();
    for (const user of ready) {
      if (done.has(String(user.userId))) {
        this.waitUntil.delete(String(user.userId));
        continue;
      }
      try {
        const next = await this.handle(plan.day, user, tick);
        if (next === 'done' || next.getTime() >= end) {
          // 끝났거나(DB에 끝난 상태가 기록됨 · 날짜가 지남), 기다릴 시각이 날짜를 넘어가면(자정 이후) 목록에서 지운다
          this.waitUntil.delete(String(user.userId));
        } else {
          this.waitUntil.set(String(user.userId), next.getTime());
          stillPending.push(user);
        }
      } catch (error) {
        this.logger.warn(`복습 알림을 처리하지 못했어요(${String(user.userId)}): ${String(error)}`);
        stillPending.push(user); // 다음 확인에서 다시
      }
      if (seoulDate(tick()) !== plan.day) break; // 자정을 넘겼으면 더 처리하지 않는다(남은 사용자는 그날 것이 아니다)
    }
    plan.pending = stillPending;
  }

  /**
   * 사용자 한 명을 처리한다. 끝났으면 'done'(DB에 끝난 상태가 기록되었거나 그날이 지남), 나중에 다시 봐야 하면 그 시각.
   * 선점을 잃었거나 못 잡은 사용자는 끝난 것이 아니다: 선점을 가져간 서버가 보내기 전에 죽을 수 있고 집계는 하루 한 번이라
   * 목록에서 지우면 아무도 다시 보지 않는다. 그래서 목록에 남기고 holderWait 가 정한 시각에 다시 본다
   */
  private async handle(day: string, user: DueUser, clock: () => Date): Promise<'done' | Date> {
    const now = clock();
    const claimId = randomUUID();
    let attempts: number;
    try {
      // 선점하면서 증가된 문서를 돌려받는다: 시도 횟수는 목록을 만든 뒤 다른 서버가 올렸을 수 있어 이 값으로 판정한다.
      // 이미 끝났거나 다른 서버가 쥐고 있으면 조건에 안 맞아 upsert 가 (userId, day) 유니크 색인에 막혀 중복 키 오류가 난다
      const claimed = await this.reminders
        .findOneAndUpdate(
          {
            userId: user.userId,
            day,
            $and: [
              { state: { $nin: FINAL_STATES } },
              {
                $or: [
                  { state: null },
                  {
                    state: 'claimed',
                    claimedAt: { $lte: new Date(now.getTime() - REVIEW_REMIND_LEASE_MS) },
                  },
                ],
              },
              { $or: [{ retryAt: null }, { retryAt: { $lte: now } }] },
              { $or: [{ attempts: null }, { attempts: { $lt: REVIEW_REMIND_MAX_ATTEMPTS } }] },
            ],
          },
          {
            $set: { state: 'claimed', claimId, claimedAt: now, retryAt: null },
            $inc: { attempts: 1 },
            $setOnInsert: { createdAt: now },
          },
          { upsert: true, returnDocument: 'after', projection: { attempts: 1 } },
        )
        .lean<{ attempts?: number } | null>();
      if (!claimed) return this.holderWait(day, user, now);
      attempts = claimed.attempts ?? 1;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        // 다른 서버가 먼저 잡았거나 이미 끝났다: 그 문서를 읽어 언제 다시 볼지 정한다
        return this.holderWait(day, user, now);
      }
      throw error;
    }

    // 발송 결과와 기록 오류를 나눈다: 발송 중 오류만 'retry'이고, 기록 오류는 결과를 바꾸지 않는다
    let outcome: Outcome | 'lost' | 'late';
    try {
      outcome = await this.send(day, user, claimId, clock);
    } catch (error) {
      this.logger.warn(`복습 알림 발송 중 오류(${String(user.userId)}): ${String(error)}`);
      outcome = 'retry';
    }
    if (outcome === 'late') return 'done'; // 날짜가 바뀌었다(그날 알림은 끝): 아무것도 쓰지 않는다
    if (outcome === 'lost') return this.holderWait(day, user, clock()); // 내 선점을 다른 서버가 가져갔다: 아무것도 쓰지 않고 목록에 남긴다
    await this.recordResult(day, user, claimId, outcome, attempts, now, clock);
    if (outcome !== 'retry' || attempts >= REVIEW_REMIND_MAX_ATTEMPTS) return 'done';
    const delay =
      REVIEW_REMIND_RETRY_DELAYS_MS[attempts - 1] ?? REVIEW_REMIND_RETRY_DELAYS_MS.at(-1)!;
    return new Date(now.getTime() + delay);
  }

  /**
   * 확인하고 보낸다. 끝낼 상태(sent · skipped) / 다시 시도할 만한 실패(retry) / 내 선점이 사라짐(lost) / 날짜가 바뀜(late).
   * 순서: 읽기들 → 선점 확인(마지막 DB 조회) → 날짜 확인 → push.send. 날짜 확인과 push.send 사이에는 await 가 없다
   */
  private async send(
    day: string,
    user: DueUser,
    claimId: string,
    clock: () => Date,
  ): Promise<Outcome | 'lost' | 'late'> {
    // 탈퇴 중 · 탈퇴한 사용자(기기 등록과 같은 기준: deletedAt · withdrawingAt)에게는 보내지 않는다
    const account = await this.users
      .findOne({ _id: user.userId }, { deletedAt: 1, withdrawingAt: 1 })
      .lean<{ deletedAt?: Date | null; withdrawingAt?: Date | null } | null>();
    if (!account || account.deletedAt || account.withdrawingAt) return 'skipped';
    // 공부 알림을 껐거나 조용한 시간이면 그날은 보내지 않는다(#560 알림 설정)
    if (!(await this.notifications.pushAllowed([user.userId], 'study', clock())).length)
      return 'skipped';

    // 집계 뒤에 지웠거나 다 익혔거나 오늘의 복습을 만들었을 수 있다: 보내기 직전에 다시 확인한다
    const count = await this.countDue(user.userId, day);
    if (count === 0) return 'skipped';
    if (await this.sets.exists({ ownerId: user.userId, reviewDay: day, deletedAt: null })) {
      return 'skipped'; // 오늘의 복습을 이미 만들었다
    }

    const devices = await this.devices
      .find({ userId: user.userId }, { pushToken: 1 })
      .lean<{ pushToken: string }[]>();
    const tokens = [...new Set(devices.map((d) => d.pushToken))].filter((t) =>
      EXPO_PUSH_TOKEN.test(t),
    );
    if (!tokens.length) return 'skipped'; // 기기가 없다: 조용히 건너뛴다

    // 내 선점이 그대로일 때만 보낸다(그사이 다른 서버가 이어받았으면 보내지 않는다). state 가 claimed 인 것만 본다:
    // closeExhausted() 는 같은 claimId 를 둔 채 gave_up 으로 닫으므로 claimId 만으로는 걸러지지 않는다
    const mine = await this.reminders
      .findOne({ userId: user.userId, day, claimId, state: 'claimed' }, { state: 1 })
      .lean<{ state?: string } | null>();
    if (!mine) return 'lost';

    // 마지막 DB 조회가 끝난 뒤 날짜를 다시 확인한다(조회를 기다리는 사이 서울 자정을 넘기면 전날 알림이 다음 날 간다).
    // 시간대가 끝났으면 보내지 않고, 다음 날 것으로 넘기지도 않는다. 이 아래에는 push.send 까지 await 가 없다
    const beforeSend = clock();
    if (seoulDate(beforeSend) !== day || !inRemindWindow(beforeSend, day)) return 'late';

    const { title, body } = remindMessage(Math.min(count, REVIEW_REMIND_MAX_COUNT));
    const userId = String(user.userId);
    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      title,
      body,
      data: { type: 'today-review' },
      sound: 'default',
      priority: 'high',
      // channelId 는 넣지 않는다: 없는 채널 id 를 넣으면 안드로이드에서 알림이 안 뜰 수 있어 기본 채널을 쓴다
      collapseId: `today-review:${day}:${userId}`,
      threadId: 'today-review',
    }));
    const result = await this.push.send(messages);
    if (result.invalidTokens.length) {
      // 만료 토큰 정리가 실패해도 이미 보낸 푸시는 성공이다(재발송하지 않는다). 다음 발송 때 다시 정리된다
      try {
        await this.devices.deleteMany({ pushToken: { $in: result.invalidTokens } });
      } catch (error) {
        this.logger.warn(`만료된 푸시 토큰을 지우지 못했어요(${userId}): ${String(error)}`);
      }
    }
    const failed = new Set(result.failedTickets.map(({ message }) => message.to));
    // 한 기기라도 보냈거나 모두 만료 토큰이면 끝. 보낼 수 있는 기기가 있었는데 전부 실패했을 때만 다시 시도한다
    return failed.size > 0 && failed.size >= tokens.length - result.invalidTokens.length
      ? 'retry'
      : 'sent';
  }

  /**
   * 선점을 잃었거나 못 잡은 사용자를 언제 다시 볼지 정한다: 그 사용자의 문서를 읽어
   * - 끝난 상태(sent · skipped · gave_up)면 'done'(목록에서 지운다)
   * - claimed 면 그 선점이 만료되는 시각(claimedAt + 선점 만료): 그 서버가 살아 있는 동안은 건드리지 않고 만료 정각에 이어받는다
   * - 대기(다시 시도 예약)면 retryAt
   * - 그 밖(문서가 없음 · 이미 만료된 선점인데 한도에 닿아 못 잡음)이면 한 번의 확인 간격 뒤
   *   (한도에 닿은 만료된 선점은 다음 확인의 closeExhausted 가 gave_up 으로 닫고, 그러면 끝난 사용자로 걸러진다)
   * 돌려준 시각이 날짜를 넘으면(자정 이후) 호출한 processPage 가 목록에서 지운다
   */
  private async holderWait(day: string, user: DueUser, now: Date): Promise<'done' | Date> {
    const fallback = new Date(now.getTime() + CONTENDED_WAIT_MS);
    const doc = await this.reminders
      .findOne({ userId: user.userId, day }, { state: 1, claimedAt: 1, retryAt: 1 })
      .lean<{ state?: string | null; claimedAt?: Date; retryAt?: Date | null } | null>();
    if (!doc) return fallback;
    if (doc.state && FINAL_STATES.includes(doc.state)) return 'done';
    if (doc.state === 'claimed' && doc.claimedAt) {
      const expiresAt = new Date(doc.claimedAt.getTime() + REVIEW_REMIND_LEASE_MS);
      return expiresAt > now ? expiresAt : fallback;
    }
    if (!doc.state && doc.retryAt && doc.retryAt > now) return doc.retryAt;
    return fallback;
  }

  /**
   * 결과를 기록한다. 기록이 실패하면 같은 결과로 0.2초 · 0.5초 뒤 다시 쓴다(선점을 풀지 않는다: 푸시를 이미 보냈을 수 있다).
   * 그래도 실패하면 sent 는 메모리에 보관해 다음 확인에서 먼저 다시 쓰고, 다른 결과는 선점이 만료되면 이어받는다
   */
  private async recordResult(
    day: string,
    user: DueUser,
    claimId: string,
    outcome: Outcome,
    attempts: number,
    claimedAt: Date,
    clock: () => Date,
  ): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await this.record(day, user, claimId, outcome, attempts, clock());
        return;
      } catch (error) {
        const delay = REVIEW_REMIND_RECORD_DELAYS_MS[i];
        if (delay === undefined) {
          this.logger.warn(
            `복습 알림 결과(${outcome})를 기록하지 못했어요(${String(user.userId)}): ${String(error)}`,
          );
          if (outcome === 'sent') this.keepUnrecorded({ user, day, claimId, claimedAt });
          return;
        }
        await this.recordWait(delay);
      }
    }
  }

  /** 결과를 쓴다. 내 선점(claimId)일 때만 쓴다: 그사이 다른 서버가 이어받았으면 아무것도 바꾸지 않는다 */
  private async record(
    day: string,
    user: DueUser,
    claimId: string,
    outcome: Outcome,
    attempts: number,
    now: Date,
  ): Promise<void> {
    const mine = { userId: user.userId, day, claimId };
    if (outcome === 'retry' && attempts < REVIEW_REMIND_MAX_ATTEMPTS) {
      const delay =
        REVIEW_REMIND_RETRY_DELAYS_MS[attempts - 1] ?? REVIEW_REMIND_RETRY_DELAYS_MS.at(-1)!;
      await this.reminders.updateOne(mine, {
        $set: { state: null, retryAt: new Date(now.getTime() + delay) },
      });
      return;
    }
    const state = outcome === 'retry' ? 'gave_up' : outcome;
    if (state === 'gave_up') {
      this.logger.warn(
        `복습 알림을 ${attempts}번 시도했지만 보내지 못해 포기해요(${String(user.userId)})`,
      );
    }
    await this.reminders.updateOne(mine, { $set: { state } });
  }

  /** 기록하지 못한 sent 를 보관한다. 상한을 넘으면 오래된 것부터 버린다 */
  private keepUnrecorded(item: Unrecorded): void {
    const key = `${item.day}:${String(item.user.userId)}`;
    this.unrecorded.delete(key);
    this.unrecorded.set(key, item);
    while (this.unrecorded.size > this.unrecordedLimit) {
      this.unrecorded.delete(this.unrecorded.keys().next().value!);
    }
  }

  /**
   * 지난 확인에서 기록하지 못한 sent 를 먼저 다시 쓴다. 내 선점(claimId) 조건으로 쓰므로 다른 서버가 이어받았으면 아무것도
   * 바꾸지 않는다. 선점이 만료된 것(REVIEW_REMIND_LEASE_MS 이상)은 이미 다른 서버가 이어받았을 수 있어 다시 쓰지 않고 버린다
   */
  private async flushUnrecorded(now: Date): Promise<void> {
    for (const [key, item] of [...this.unrecorded]) {
      if (now.getTime() - item.claimedAt.getTime() >= REVIEW_REMIND_LEASE_MS) {
        this.unrecorded.delete(key);
        continue;
      }
      try {
        await this.record(item.day, item.user, item.claimId, 'sent', 1, now);
        this.unrecorded.delete(key);
      } catch (error) {
        this.logger.warn(`보관한 복습 알림 기록을 다시 쓰지 못했어요(${key}): ${String(error)}`);
      }
    }
  }

  /**
   * 시도 횟수가 한도에 닿은 채 선점이 만료된 claimed 를 gave_up 으로 닫는다(한도에 닿으면 더는 선점하지 못해 끝난 상태가
   * 되지 못한다). 선점이 아직 살아 있는 것(다른 서버가 처리 중)은 건드리지 않는다.
   * 이 경우 푸시는 실제로 갔을 수도 있다(보낸 뒤 기록이 실패했거나 서버가 죽음)
   */
  private async closeExhausted(day: string, now: Date): Promise<void> {
    await this.reminders.updateMany(
      {
        day,
        state: 'claimed',
        claimedAt: { $lte: new Date(now.getTime() - REVIEW_REMIND_LEASE_MS) },
        attempts: { $gte: REVIEW_REMIND_MAX_ATTEMPTS },
      },
      { $set: { state: 'gave_up' } },
    );
  }

  private logFailure(error: unknown): void {
    this.logger.warn(`복습 알림 확인을 다시 시도해요: ${String(error)}`);
  }
}
