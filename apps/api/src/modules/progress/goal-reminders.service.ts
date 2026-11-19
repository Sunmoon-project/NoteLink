import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type Model, Types } from 'mongoose';

import { HolidaysService } from '../calendar/holidays.service.js';
import { NotificationService } from '../notification/notification.service.js';
import { ExpoPushService, type ExpoPushMessage } from '../notification/expo-push.service.js';
import { StudySession } from '../session/schemas/study-session.schema.js';
import { LAST_SEEN_GRACE_MS, lastAliveAt } from '../session/study.service.js';
import { seoulDate } from '../session/study-time.js';
import { Device } from '../users/schemas/device.schema.js';
import { todayStudyMin, type DayStudy } from './goal-judge.js';
import {
  REMIND_MAX_ATTEMPTS,
  REMIND_RETRY_DELAYS_MS,
  inRemindWindow,
  remindMessage,
  remindStart,
  weekdayOfDate,
} from './goal-remind.js';
import {
  toDayStudy,
  toRule,
  versionFilter,
  type DayLean,
  type GoalLean,
} from './recurring-goals.service.js';
import { DailyRecord } from './schemas/daily-record.schema.js';
import { RecurringGoal } from './schemas/recurring-goal.schema.js';

/** 리마인드 대상을 확인하는 간격 */
const REMIND_SCAN_MS = 60_000;
/** 한 번에 읽는 후보 수(다 읽을 때까지 _id 순서로 이어서 읽는다) */
const REMIND_PAGE = 500;
const EXPO_PUSH_TOKEN = /^(?:Expo|Exponent)PushToken\[[^\]]+\]$/;

/** 사용자 한 명의 오늘 공부 기록 · 건너뛸 날 (한 번 확인하는 동안 목표들이 같이 쓴다) */
interface UserDay {
  study: Map<string, DayStudy>;
  skipDates: Set<string>;
}

/**
 * 반복 목표 미달성 리마인드 푸시(FR-11-07 · 08). 목표 요일의 리마인드 시각(기본 21:00)이 지나고 2시간 안(서울 자정까지)에
 * 오늘 공부 시간이 목표보다 적으면 "오늘 목표까지 O분 남았어요"를 하루 한 번 보낸다.
 * 서버가 여러 대여도 목표 문서의 lastRemindedOn(서울 날짜)을 조건부 갱신으로 먼저 잡은 서버만 판정 · 발송한다.
 * 발송이 모두 실패하면 표시를 풀어 다음 확인에서 다시 시도한다(하루 3회까지, 2분 · 10분 간격).
 * 후보를 읽은 뒤 설정이 바뀌면(remindVersion이 달라지면) 잡지 않고 넘어가 다음 확인에서 새 설정으로 다시 판단한다.
 * 잡은 뒤에 바뀐 설정은 그 발송에 반영하지 않고, 그날은 다시 보내지 않는다(FR-11-08: 보낸 날은 다시 안 보냄).
 * 서버가 잡은 직후 죽으면 그날은 보내지 못할 수 있다(중복 푸시보다 누락을 택했다).
 * 지금 타이머를 켜고 공부 중이면(열린 세션의 마지막 생존 시각이 LAST_SEEN_GRACE_MS 안) 보내지 않는다: 세션은 끝나야 하루 기록에
 * 정산되므로 기록만 보면 이미 채웠어도 미달로 보이기 때문이다. 이때는 표시를 풀어 다음 확인에서 다시 판단한다(그날 보낸 것으로 치지 않고
 * 시도 횟수도 쓰지 않는다). 신호가 끊긴 열린 세션(앱 강제 종료 등)은 측정 중으로 보지 않는다
 */
@Injectable()
export class GoalRemindersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GoalRemindersService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(RecurringGoal.name) private readonly goals: Model<RecurringGoal>,
    @InjectModel(DailyRecord.name) private readonly daily: Model<DailyRecord>,
    @InjectModel(StudySession.name) private readonly sessions: Model<StudySession>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly holidays: HolidaysService,
    private readonly push: ExpoPushService,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    void this.runOnce().catch((error: unknown) => this.logFailure(error));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.logFailure(error));
    }, REMIND_SCAN_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 테스트와 운영 스케줄러가 공유하는 한 번의 확인. 겹쳐 부르면 뒤의 호출은 바로 끝난다 */
  async runOnce(startedAt?: Date, clock?: () => Date): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // 시각을 직접 준 호출(테스트)은 그 시각으로 고정하고, 운영은 목표마다 실제 시계를 다시 읽는다
      const tick = clock ?? (startedAt ? () => startedAt : () => new Date());
      const now = startedAt ?? tick();
      const today = seoulDate(now);
      const weekday = weekdayOfDate(today);
      let after: Types.ObjectId | null = null;
      for (;;) {
        const page: GoalLean[] = await this.goals
          .find({
            ...(after ? { _id: { $gt: after } } : {}),
            isActive: true,
            remindEnabled: true,
            deletedAt: null,
            days: weekday,
            lastRemindedOn: { $ne: today },
          })
          .sort({ _id: 1 })
          .limit(REMIND_PAGE)
          .lean<GoalLean[]>();
        const userDays = new Map<string, Promise<UserDay>>();
        for (const goal of page) {
          // 선점 직전에 시계를 다시 읽는다. 자정을 넘겼으면 오늘(시작 때 날짜) 기준 판정은 더 하지 않는다
          const current = tick();
          if (seoulDate(current) !== today) return;
          try {
            await this.handle(goal, current, today, userDays, tick);
          } catch (error) {
            this.logger.warn(
              `목표 리마인드를 처리하지 못했어요(${String(goal._id)}): ${String(error)}`,
            );
          }
        }
        if (page.length < REMIND_PAGE) break;
        after = page[page.length - 1]!._id;
      }
    } finally {
      this.running = false;
    }
  }

  private async handle(
    goal: GoalLean,
    now: Date,
    today: string,
    userDays: Map<string, Promise<UserDay>>,
    clock: () => Date,
  ): Promise<void> {
    if (!inRemindWindow(now, today, goal.remindTime)) return;
    // 리마인드 시각 이후에 만든 목표는 그날 건너뛴다
    if (goal.createdAt && goal.createdAt >= remindStart(today, goal.remindTime)) return;
    if (goal.remindRetryAt && goal.remindRetryAt > now) return;
    const attempts = goal.remindAttemptsOn === today ? (goal.remindAttempts ?? 0) : 0;
    if (attempts >= REMIND_MAX_ATTEMPTS) return;

    const previous = goal.lastRemindedOn ?? null;
    const claimedVersion = goal.remindVersion;
    const claimId = randomUUID();
    const claimed = await this.goals.updateOne(
      {
        _id: goal._id,
        isActive: true,
        remindEnabled: true,
        deletedAt: null,
        lastRemindedOn: { $ne: today },
        remindVersion: versionFilter(goal.remindVersion),
        $or: [{ remindRetryAt: null }, { remindRetryAt: { $lte: now } }],
      },
      { $set: { lastRemindedOn: today, remindClaimId: claimId } },
    );
    if (!claimed.matchedCount) return; // 다른 서버가 먼저 잡았다

    try {
      const outcome = await this.judgeAndSend(goal, now, today, userDays, clock);
      if (outcome === 'done') return;
      if (outcome === 'measuring') {
        await this.defer(goal, claimId, claimedVersion, previous);
        return;
      }
    } catch (error) {
      this.logger.warn(`목표 리마인드 발송 중 오류(${String(goal._id)}): ${String(error)}`);
    }
    await this.failed(goal, claimId, claimedVersion, previous, attempts + 1, now, today);
  }

  /**
   * 판정하고 보낸다. 결과: 'done' 보냈거나 보낼 게 없음(표시 유지), 'retry' 다시 시도할 만한 실패(보낼 기기가 있는데 전부 실패),
   * 'measuring' 지금 타이머를 켜고 공부 중이라 보내지 않음(표시를 풀어 다음 확인에서 다시 판단)
   */
  private async judgeAndSend(
    goal: GoalLean,
    now: Date,
    today: string,
    userDays: Map<string, Promise<UserDay>>,
    clock: () => Date,
  ): Promise<'done' | 'retry' | 'measuring'> {
    const userId = String(goal.userId);
    let day = userDays.get(userId);
    if (!day) {
      day = this.loadDay(goal.userId, today);
      userDays.set(userId, day);
    }
    const { study, skipDates } = await day;
    const todayMin = todayStudyMin(toRule(goal), today, study, skipDates);
    // 오늘 판정 대상이 아니거나 이미 채웠으면 표시만 남긴다
    if (todayMin === null || todayMin >= goal.targetMin) return 'done';
    // 미달로 보이는 사람에게만 확인한다. 공부 중이면 아직 정산되지 않은 시간이 있으니 지금은 판단하지 않는다
    if (await this.isMeasuring(goal.userId, now)) return 'measuring';

    // 공부 알림을 껐거나 조용한 시간이면 그날은 보내지 않는다(#560 알림 설정)
    if (!(await this.notifications.pushAllowed([goal.userId], 'study', now)).length) return 'done';

    const devices = await this.devices
      .find({ userId: goal.userId }, { pushToken: 1 })
      .lean<{ pushToken: string }[]>();
    const tokens = [...new Set(devices.map((d) => d.pushToken))].filter((t) =>
      EXPO_PUSH_TOKEN.test(t),
    );
    if (!tokens.length) return 'done'; // 기기가 없다

    // 선점 · 기록 · 기기 조회를 기다리는 사이 자정을 넘기거나 발송 시간대가 끝났을 수 있다. 그러면 보내지 않고 끝낸다.
    // 표시(lastRemindedOn)는 선점한 날짜로 그대로 둔다: 자정을 넘겼다면 전날 날짜라 다음 날 판정에 영향이 없고,
    // failed()를 거치지 않으므로 다시 시도할 예약도 생기지 않는다
    const beforeSend = clock();
    if (seoulDate(beforeSend) !== today || !inRemindWindow(beforeSend, today, goal.remindTime))
      return 'done';

    const { title, body } = remindMessage(goal.name, goal.targetMin, todayMin);
    const id = String(goal._id);
    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      title,
      body,
      data: { type: 'goal-remind', goalId: id },
      sound: 'default',
      priority: 'high',
      collapseId: `goal-remind:${id}:${today}`,
      threadId: `goal-remind-${id}`,
    }));
    const result = await this.push.send(messages);
    if (result.invalidTokens.length) {
      // 만료 토큰 정리가 실패해도 이미 보낸 푸시는 성공이다(재발송하지 않는다). 다음 발송 때 다시 정리된다
      try {
        await this.devices.deleteMany({ pushToken: { $in: result.invalidTokens } });
      } catch (error) {
        this.logger.warn(
          `만료된 푸시 토큰을 지우지 못했어요(${String(goal._id)}): ${String(error)}`,
        );
      }
    }
    const failed = new Set(result.failedTickets.map(({ message }) => message.to));
    // 한 기기라도 보냈거나 모두 만료 토큰이면 끝. 보낼 수 있는 기기가 있었는데 전부 실패했을 때만 다시 시도한다
    return failed.size > 0 && failed.size >= tokens.length - result.invalidTokens.length
      ? 'retry'
      : 'done';
  }

  /**
   * 지금 타이머로 공부 중인지. 열린 세션(끝나지 않은 것 — 사용자당 하나)의 마지막 생존 시각(lastAliveAt: 마지막 신호 ·
   * 시작 · 정지 기록 중 가장 늦은 것)이 LAST_SEEN_GRACE_MS 안이면 측정 중이다. 정산이 꺼진 세션을 닫을 때 쓰는 기준(#504)과 같다.
   * 일시정지 중이어도 앱이 신호를 보내는 동안은 측정 중이다(앱은 10분 쉬면 알아서 끝낸다)
   */
  private async isMeasuring(userId: Types.ObjectId, now: Date): Promise<boolean> {
    const open = await this.sessions
      .findOne({ userId, status: { $ne: 'ended' } }, { startedAt: 1, lastSeenAt: 1, pauses: 1 })
      .lean<Pick<StudySession, 'startedAt' | 'lastSeenAt' | 'pauses'> | null>();
    return open !== null && now.getTime() - lastAliveAt(open).getTime() <= LAST_SEEN_GRACE_MS;
  }

  /**
   * 측정 중이라 이번에는 보내지 않았다: 선점한 표시만 이전 값으로 푼다. 시도 횟수 · 다시 시도 예약은 쓰지 않으니
   * 다음 확인(1분 뒤)에서 새로 판단한다. 설정이 그사이 바뀌었으면(remindVersion) failed()처럼 아무것도 되돌리지 않는다.
   * 되돌리지 못하면 그날은 못 보낼 수 있다(중복보다 누락을 택한 기존 규칙과 같다)
   */
  private async defer(
    goal: GoalLean,
    claimId: string,
    claimedVersion: number | undefined,
    previous: string | null,
  ): Promise<void> {
    try {
      await this.goals.updateOne(
        { _id: goal._id, remindClaimId: claimId, remindVersion: versionFilter(claimedVersion) },
        { $set: { lastRemindedOn: previous } },
      );
    } catch (error) {
      this.logger.warn(
        `측정 중인 목표의 리마인드 표시를 풀지 못했어요(${String(goal._id)}): ${String(error)}`,
      );
    }
  }

  private loadDay(userId: Types.ObjectId, today: string): Promise<UserDay> {
    return Promise.all([
      this.daily
        .find(
          { userId, studyDate: today },
          {
            studyDate: 1,
            totalSec: 1,
            subjectSec: 1,
            'items.subjectId': 1,
            'items.accumulatedSec': 1,
          },
        )
        .lean<DayLean[]>(),
      this.holidays.skipDates(String(userId), today, today),
    ]).then(([records, skipList]) => ({
      study: new Map(records.map((r) => [r.studyDate, toDayStudy(r)])),
      skipDates: new Set(skipList),
    }));
  }

  /** 발송에 실패했다: 상한 전이면 표시를 이전 값으로 풀어 다음 시도 시각을 정하고, 상한이면 그날은 포기한다(표시 유지) */
  private async failed(
    goal: GoalLean,
    claimId: string,
    claimedVersion: number | undefined,
    previous: string | null,
    attempts: number,
    now: Date,
    today: string,
  ): Promise<void> {
    // 선점한 뒤 update()로 설정이 바뀌었으면(remindVersion이 달라졌으면) 아무것도 되돌리지 않는다. 그 변경이 오늘 건너뜀 표시를 남겼을 수 있다.
    // 건너뜀 표시 없이 바뀐 설정(예: 목표 시간만 변경)에서 발송이 실패한 경우에도 그날은 다시 보내지 않는다
    const mine = {
      _id: goal._id,
      remindClaimId: claimId,
      remindVersion: versionFilter(claimedVersion),
    };
    if (attempts >= REMIND_MAX_ATTEMPTS) {
      await this.goals.updateOne(mine, {
        $set: { remindAttempts: attempts, remindAttemptsOn: today, remindRetryAt: null },
      });
      this.logger.warn(
        `목표 리마인드를 ${attempts}번 시도했지만 보내지 못해 오늘은 포기해요(${String(goal._id)})`,
      );
      return;
    }
    const delay = REMIND_RETRY_DELAYS_MS[attempts - 1] ?? REMIND_RETRY_DELAYS_MS.at(-1)!;
    await this.goals.updateOne(mine, {
      $set: {
        lastRemindedOn: previous,
        remindAttempts: attempts,
        remindAttemptsOn: today,
        remindRetryAt: new Date(now.getTime() + delay),
      },
    });
  }

  private logFailure(error: unknown): void {
    this.logger.warn(`목표 리마인드 확인을 다시 시도해요: ${String(error)}`);
  }
}
