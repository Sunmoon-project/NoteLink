import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type Model, Types } from 'mongoose';

import { syncFromJob } from '../modules/content/materials/material-sync.js';
import type { MaterialRow } from '../modules/content/materials/material-view.js';
import { Material } from '../modules/content/schemas/material.schema.js';
import {
  ExpoPushService,
  type ExpoPushMessage,
} from '../modules/notification/expo-push.service.js';
import { NotificationService } from '../modules/notification/notification.service.js';
import { AiJob } from '../modules/quiz/schemas/ai-job.schema.js';
import { QuizSet } from '../modules/quiz/schemas/quiz-set.schema.js';
import { Device } from '../modules/users/schemas/device.schema.js';
import { resultQuestions, SIMILAR_TYPE } from '../quiz-sets/quiz-sets.service.js';
import { type AppAiJob, PREGEN_TYPE } from './ai-jobs.service.js';

/** 끝난 작업을 확인하는 간격 */
const NOTICE_SCAN_MS = 60_000;
/** 한 번에 읽는 후보 수(다 읽을 때까지 _id 순서로 이어서 읽는다) */
const NOTICE_PAGE = 500;
/** 끝난 지(updatedAt) 이 시간이 지난 작업은 보내지 않는다(배포 전에 끝난 옛 작업 · 오래 멈췄던 서버 뒤의 낡은 알림) */
export const NOTICE_WINDOW_MS = 30 * 60 * 1000;
/** 선점한 서버가 이 시간 안에 결과를 기록하지 않으면 죽은 것으로 보고 다른 서버가 이어받는다 */
export const NOTICE_LEASE_MS = 2 * 60 * 1000;
/** 한 작업에 보내 보는 최대 횟수(처음 + 재시도 2회. 이어받기도 한 번으로 센다) */
export const NOTICE_MAX_ATTEMPTS = 3;
/** 실패한 n번째 시도(1부터) 뒤 다음 시도까지 기다리는 시간: 2분, 10분 */
export const NOTICE_RETRY_DELAYS_MS = [2 * 60 * 1000, 10 * 60 * 1000];
/** 결과 기록(notice 쓰기)이 실패했을 때 다시 쓰기 전에 기다리는 시간: 0.2초, 0.5초(그 뒤에도 실패하면 보관해 다음 확인에서 다시 쓴다) */
export const NOTICE_RECORD_RETRY_DELAYS_MS = [200, 500];
/** 기록하지 못한 sent 를 메모리에 보관하는 최대 개수(넘으면 오래된 것부터 버린다) */
export const NOTICE_UNRECORDED_MAX = 200;

const SUMMARY_TYPES = ['handwriting_summary', 'recording_summary', 'document_summary'];
/** 퀴즈 세트를 만드는 작업(대상은 그 세트). 미리 만들기(quiz_pregen)는 사용자가 기다리게 된 것(awaited)만 알린다 */
const QUIZ_TYPES = ['quiz_generate', 'similar_quiz'];
/** 알릴 작업: 노트 정리 · 퀴즈 만들기 · 사용자가 기다린 미리 만들기 */
const NOTICE_TARGETS = {
  $or: [
    { type: { $in: SUMMARY_TYPES }, targetType: 'material' },
    { type: { $in: QUIZ_TYPES }, targetType: 'quiz_set' },
    { type: PREGEN_TYPE, awaited: true },
  ],
};
const EXPO_PUSH_TOKEN = /^(?:Expo|Exponent)PushToken\[[^\]]+\]$/;
/** notice를 쓰는 모든 쓰기: updatedAt이 처리기가 끝낸 시각 그대로 남아야 30분 기준이 맞는다 */
const NO_TIMESTAMPS = { timestamps: false } as const;
/** 더 고르지 않는 최종 상태 */
const FINAL_STATES = ['sent', 'skipped', 'gave_up'];

const MESSAGES = {
  summary: {
    succeeded: '노트 정리가 끝났어요',
    failed: '노트 정리에 실패했어요. 다시 시도해 주세요',
  },
  quiz: { succeeded: '퀴즈가 준비됐어요', failed: '퀴즈를 만들지 못했어요. 다시 시도해 주세요' },
  similar: {
    succeeded: '유사 문제가 준비됐어요',
    failed: '유사 문제를 만들지 못했어요. 다시 시도해 주세요',
  },
} as const;

interface JobLean {
  _id: Types.ObjectId;
  type: string;
  status: 'succeeded' | 'failed';
  userId: Types.ObjectId;
  targetId: Types.ObjectId;
  /** 후보를 읽은 때의 값이라 오래됐을 수 있다. 시도 횟수 판정에는 선점 응답의 값을 쓴다 */
  notice?: { attempts?: number } | null;
}

type Outcome = 'sent' | 'skipped' | 'retry';

/** 푸시는 보냈는데 sent 를 기록하지 못한 작업(메모리 보관). 다음 확인에서 먼저 다시 쓴다 */
interface Unrecorded {
  job: JobLean;
  claimId: string;
  /** 선점한 시각: 이 시각 + NOTICE_LEASE_MS 가 지나면 다른 서버가 이어받았을 수 있어 다시 쓰지 않고 버린다 */
  claimedAt: Date;
  attempts: number;
}

/**
 * 노트 변환(요약 작업) · 퀴즈 만들기(quiz_generate · similar_quiz · 사용자가 기다린 quiz_pregen)가 끝나면
 * 알림함에 남기고 푸시로 알린다(FR-65-02, #560). AI 처리기가 ai_jobs 상태를 DB에 직접 쓰므로 서버는
 * 끝난 시점을 스스로 알 수 없어, goal-reminders.service.ts처럼 주기적으로 끝난 작업을 찾아 보낸다.
 *
 * - status는 succeeded · failed만 본다. failed는 처리기가 자동 재시도 한도를 다 쓴 뒤에만 쓰는 최종 상태다
 *   (apps/ai jobs.py fail(): 중간에는 queued로 되돌린다). 그래서 failed를 보고 바로 알려도 된다.
 * - 작업마다 한 번: notice.claimId를 조건부 갱신으로 먼저 잡은 서버만 보낸다(서버가 여러 대여도 한 번).
 *   선점한 서버가 죽으면 NOTICE_LEASE_MS 뒤 다른 서버가 이어받는다(이때 기기에서는 collapseId로 하나로 합쳐진다).
 * - 보내기 직전에 작업을 다시 읽어, 그사이 다시 시도되어 상태가 바뀌었으면(retry가 notice를 지운다) 보내지 않는다.
 * - 노트가 지워졌거나 노트가 이 작업을 가리키지 않으면(다른 작업으로 다시 연결됨) 푸시 없이 skipped로 끝낸다.
 *   퀴즈는 이 작업을 가리키는(jobId) 지우지 않은 세트가 없으면 skipped(미리 만들기는 세트를 만들기 전이라 다시 시도).
 * - 알림함(NotificationService.saveToInbox): 같은 collapseId라 다시 시도해도 한 줄. AI 알림을 껐거나 탈퇴했으면 저장 · 푸시 없이
 *   skipped, 기기가 없거나 조용한 시간이면 알림함에만 남기고 sent.
 * - 기준 시각은 updatedAt이다(처리기가 끝낼 때 쓰고, 이후 이 서비스는 timestamps:false로만 쓴다).
 * - 무효 토큰 정리가 실패해도 발송은 성공으로 본다(재발송 금지). 발송이 전부 실패하면 NOTICE_MAX_ATTEMPTS까지 다시 시도한다.
 * - 발송 결과와 기록 오류는 따로 다룬다: 푸시를 보낸 뒤 sent 기록이 실패해도 선점을 풀지 않고 sent 만 다시 쓴다
 *   (0.2초 · 0.5초 뒤, 그래도 실패하면 메모리에 보관했다가 다음 확인 때 먼저 다시 쓴다. 선점 만료 뒤에는 버린다).
 * - 시도 횟수는 후보를 읽을 때의 값이 아니라 선점 응답(returnDocument: after)의 실제 값으로 판정한다.
 * - 시도 횟수가 한도에 닿은 채 선점이 만료된 claimed 는 gave_up 으로 닫는다.
 *
 * 남는 한계: 푸시를 보낸 뒤 sent 기록이 선점 만료(NOTICE_LEASE_MS, 2분) 넘게 실패하거나 그 사이 서버가 죽으면,
 * 다른 서버가 이어받아 같은 알림을 한 번 더 보낼 수 있다(누락보다 중복을 택했다. 같은 collapseId라 기기에서는 보통
 * 한 알림으로 합쳐진다). 한도에 닿은 만료된 claimed 를 gave_up 으로 닫을 때도 푸시는 실제로 갔을 수 있다.
 */
@Injectable()
export class AiJobNoticesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AiJobNoticesService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  /** 푸시는 보냈지만 sent 를 기록하지 못한 작업(작업 id → 보관 항목). 오래된 것이 앞에 있다 */
  private readonly unrecorded = new Map<string, Unrecorded>();
  /** 기록하지 못한 sent 를 보관하는 최대 개수(테스트에서 바꿔 끼운다) */
  unrecordedLimit = NOTICE_UNRECORDED_MAX;
  /** 기록을 다시 쓰기 전 기다림(테스트에서 실제로 기다리지 않게 바꿔 끼운다) */
  recordWait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectModel(AiJob.name) private readonly jobs: Model<AiJob>,
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly push: ExpoPushService,
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSet>,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    void this.runOnce().catch((error: unknown) => this.logFailure(error));
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.logFailure(error));
    }, NOTICE_SCAN_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.unrecorded.clear();
  }

  /** 테스트와 운영 스케줄러가 공유하는 한 번의 확인. 겹쳐 부르면 뒤의 호출은 바로 끝난다 */
  async runOnce(startedAt?: Date, clock?: () => Date): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tick = clock ?? (startedAt ? () => startedAt : () => new Date());
      // 먼저 지난 확인에서 기록하지 못한 sent 를 다시 쓰고, 한도에 닿은 만료된 선점을 닫는다(실패해도 이어서 확인한다)
      await this.flushUnrecorded(tick()).catch((e: unknown) => this.logFailure(e));
      await this.closeExhausted(tick()).catch((e: unknown) => this.logFailure(e));
      let after: Types.ObjectId | null = null;
      for (;;) {
        const now = tick();
        const page: JobLean[] = await this.jobs
          .find(
            {
              ...(after ? { _id: { $gt: after } } : {}),
              status: { $in: ['succeeded', 'failed'] },
              updatedAt: { $gte: new Date(now.getTime() - NOTICE_WINDOW_MS) },
              'notice.state': { $nin: FINAL_STATES },
              $and: [
                NOTICE_TARGETS,
                // 한도에 닿은 작업은 고르지 않는다(만료된 claimed 는 closeExhausted 가 닫는다)
                {
                  $or: [
                    { 'notice.attempts': null },
                    { 'notice.attempts': { $lt: NOTICE_MAX_ATTEMPTS } },
                  ],
                },
              ],
            },
            { type: 1, status: 1, userId: 1, targetId: 1, notice: 1 },
          )
          .sort({ _id: 1 })
          .limit(NOTICE_PAGE)
          .lean<JobLean[]>();
        for (const job of page) {
          try {
            await this.handle(job, tick);
          } catch (error) {
            this.logger.warn(
              `노트 변환 알림을 처리하지 못했어요(${String(job._id)}): ${String(error)}`,
            );
          }
        }
        if (page.length < NOTICE_PAGE) break;
        after = page[page.length - 1]!._id;
      }
    } finally {
      this.running = false;
    }
  }

  private async handle(job: JobLean, clock: () => Date): Promise<void> {
    const now = clock();
    if ((job.notice?.attempts ?? 0) >= NOTICE_MAX_ATTEMPTS) return; // 읽은 값으로 하는 빠른 걸러내기

    const claimId = randomUUID();
    // 선점하면서 증가된 문서를 돌려받는다: 시도 횟수는 후보를 읽은 뒤 다른 서버가 올렸을 수 있어 이 값으로 판정한다
    const claimed = await this.jobs
      .findOneAndUpdate(
        {
          _id: job._id,
          status: job.status, // 읽은 뒤 다시 시도되어 바뀌었으면 잡지 않는다
          updatedAt: { $gte: new Date(now.getTime() - NOTICE_WINDOW_MS) },
          $and: [
            { 'notice.state': { $nin: FINAL_STATES } },
            {
              $or: [
                { 'notice.state': null },
                {
                  'notice.state': 'claimed',
                  'notice.claimedAt': { $lte: new Date(now.getTime() - NOTICE_LEASE_MS) },
                },
              ],
            },
            { $or: [{ 'notice.retryAt': null }, { 'notice.retryAt': { $lte: now } }] },
            {
              $or: [
                { 'notice.attempts': null },
                { 'notice.attempts': { $lt: NOTICE_MAX_ATTEMPTS } },
              ],
            },
          ],
        },
        {
          $set: {
            'notice.state': 'claimed',
            'notice.claimId': claimId,
            'notice.claimedAt': now,
            'notice.retryAt': null,
          },
          $inc: { 'notice.attempts': 1 },
        },
        { ...NO_TIMESTAMPS, returnDocument: 'after', projection: { notice: 1 } },
      )
      .lean<{ notice?: { attempts?: number } | null } | null>();
    if (!claimed) return; // 다른 서버가 먼저 잡았다
    const attempts = claimed.notice?.attempts ?? 1;

    // 발송 결과와 기록 오류를 나눈다: 발송 중 오류만 'retry'이고, 기록 오류는 결과를 바꾸지 않는다
    let outcome: Outcome | 'abandoned';
    try {
      outcome = await this.send(job, claimId, clock);
    } catch (error) {
      this.logger.warn(`노트 변환 알림 발송 중 오류(${String(job._id)}): ${String(error)}`);
      outcome = 'retry';
    }
    if (outcome === 'abandoned') return; // 내 선점이 사라졌다(다시 시도됨): 아무것도 쓰지 않는다
    await this.recordResult(job, claimId, outcome, attempts, now, clock);
  }

  /**
   * 결과를 기록한다. 기록이 실패하면 같은 결과로 0.2초 · 0.5초 뒤 다시 쓴다(선점을 풀지 않는다: 푸시를 이미 보냈을 수 있다).
   * 그래도 실패하면 sent 는 메모리에 보관해 다음 확인에서 먼저 다시 쓰고, 다른 결과는 선점이 만료되면 이어받는다
   */
  private async recordResult(
    job: JobLean,
    claimId: string,
    outcome: Outcome,
    attempts: number,
    claimedAt: Date,
    clock: () => Date,
  ): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await this.record(job, claimId, outcome, attempts, clock());
        return;
      } catch (error) {
        const delay = NOTICE_RECORD_RETRY_DELAYS_MS[i];
        if (delay === undefined) {
          this.logger.warn(
            `노트 변환 알림 결과(${outcome})를 기록하지 못했어요(${String(job._id)}): ${String(error)}`,
          );
          if (outcome === 'sent') this.keepUnrecorded({ job, claimId, claimedAt, attempts });
          return;
        }
        await this.recordWait(delay);
      }
    }
  }

  /** 기록하지 못한 sent 를 보관한다. 상한을 넘으면 오래된 것부터 버린다 */
  private keepUnrecorded(item: Unrecorded): void {
    const key = String(item.job._id);
    this.unrecorded.delete(key);
    this.unrecorded.set(key, item);
    while (this.unrecorded.size > this.unrecordedLimit) {
      this.unrecorded.delete(this.unrecorded.keys().next().value!);
    }
  }

  /**
   * 지난 확인에서 기록하지 못한 sent 를 먼저 다시 쓴다. 내 선점(claimId) 조건으로 쓰므로 그사이 다시 시도되었거나
   * 다른 서버가 이어받았으면 아무것도 바꾸지 않는다. 선점이 만료된 것(NOTICE_LEASE_MS 이상)은 이미 다른 서버가
   * 이어받았을 수 있어 다시 쓰지 않고 버린다
   */
  private async flushUnrecorded(now: Date): Promise<void> {
    for (const [key, item] of [...this.unrecorded]) {
      if (now.getTime() - item.claimedAt.getTime() >= NOTICE_LEASE_MS) {
        this.unrecorded.delete(key);
        continue;
      }
      try {
        await this.record(item.job, item.claimId, 'sent', item.attempts, now);
        this.unrecorded.delete(key);
      } catch (error) {
        this.logger.warn(`보관한 알림 기록을 다시 쓰지 못했어요(${key}): ${String(error)}`);
      }
    }
  }

  /**
   * 시도 횟수가 한도에 닿은 채 선점이 만료된 claimed 를 gave_up 으로 닫는다(한도에 닿으면 더는 선점하지 못해 끝난 상태가
   * 되지 못한다). 선점이 아직 살아 있는 것(다른 서버가 처리 중)은 건드리지 않는다.
   * 이 경우 푸시는 실제로 갔을 수도 있다(보낸 뒤 기록이 실패했거나 서버가 죽음)
   */
  private async closeExhausted(now: Date): Promise<void> {
    await this.jobs.updateMany(
      {
        $and: [NOTICE_TARGETS],
        status: { $in: ['succeeded', 'failed'] },
        updatedAt: { $gte: new Date(now.getTime() - NOTICE_WINDOW_MS) },
        'notice.state': 'claimed',
        'notice.claimedAt': { $lte: new Date(now.getTime() - NOTICE_LEASE_MS) },
        'notice.attempts': { $gte: NOTICE_MAX_ATTEMPTS },
      },
      { $set: { 'notice.state': 'gave_up' } },
      NO_TIMESTAMPS,
    );
  }

  /** 확인하고 보낸다. 끝낼 상태(sent · skipped) / 다시 시도할 만한 실패(retry) / 내 선점이 사라짐(abandoned) */
  private async send(
    job: JobLean,
    claimId: string,
    clock: () => Date,
  ): Promise<'sent' | 'skipped' | 'retry' | 'abandoned'> {
    const notice = await this.contentOf(job);
    if (!notice) return 'skipped';
    if (notice === 'later') return 'retry';

    const devices = await this.devices
      .find({ userId: job.userId }, { pushToken: 1 })
      .lean<{ pushToken: string }[]>();
    const tokens = [...new Set(devices.map((d) => d.pushToken))].filter((t) =>
      EXPO_PUSH_TOKEN.test(t),
    );

    // 선점 · 노트 · 기기 조회를 기다리는 사이 다시 시도되었을 수 있다: 내 선점과 상태가 그대로일 때만 보낸다.
    // notice.state 가 claimed 인 것만 본다: closeExhausted() 는 같은 claimId 를 둔 채 gave_up 으로 닫으므로 claimId 만으로는 걸러지지 않는다
    const current = await this.jobs
      .findOne(
        {
          _id: job._id,
          status: job.status,
          'notice.claimId': claimId,
          'notice.state': 'claimed',
          updatedAt: { $gte: new Date(clock().getTime() - NOTICE_WINDOW_MS) },
        },
        { _id: 1 },
      )
      .lean();
    if (!current) return 'abandoned';

    const id = String(job._id);
    const collapseId = `ai-job-done:${id}`;
    // 알림함에 남긴다(같은 collapseId라 다시 시도해도 하나). AI 알림을 껐으면 저장 · 푸시 모두 없다
    const inbox = await this.notifications.saveToInbox({
      userIds: [job.userId],
      category: 'ai',
      type: notice.data.type,
      title: notice.title,
      body: notice.body,
      data: notice.data,
      collapseId,
    });
    const notificationId = inbox.get(String(job.userId));
    if (!notificationId) return 'skipped';
    // 기기가 없거나 조용한 시간이면 알림함에만 남긴다
    if (!tokens.length) return 'sent';
    if (!(await this.notifications.pushAllowed([job.userId], 'ai', clock())).length) return 'sent';
    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      title: notice.title,
      body: notice.body,
      data: { ...notice.data, notificationId },
      sound: 'default',
      priority: 'high',
      collapseId,
      threadId: notice.threadId,
    }));
    const result = await this.push.send(messages);
    if (result.invalidTokens.length) {
      // 만료 토큰 정리가 실패해도 이미 보낸 푸시는 성공이다(재발송하지 않는다). 다음 발송 때 다시 정리된다
      try {
        await this.devices.deleteMany({ pushToken: { $in: result.invalidTokens } });
      } catch (error) {
        this.logger.warn(`만료된 푸시 토큰을 지우지 못했어요(${id}): ${String(error)}`);
      }
    }
    const failed = new Set(result.failedTickets.map(({ message }) => message.to));
    // 한 기기라도 보냈거나 모두 만료 토큰이면 끝. 보낼 수 있는 기기가 있었는데 전부 실패했을 때만 다시 시도한다
    return failed.size > 0 && failed.size >= tokens.length - result.invalidTokens.length
      ? 'retry'
      : 'sent';
  }

  /**
   * 알림 내용. 지운 노트 · 다른 작업에 다시 연결된 노트, 지운 퀴즈 세트 · 이 작업의 것이 아닌 세트면 null(보내지 않는다).
   * 노트는 이 작업이 노트의 현재 작업(processing.jobId) · 현재 다시 만들기 작업(processing.regenJobId) ·
   * 마지막으로 끝난 다시 만들기 작업(processing.lastRegenJobId)일 때만 알린다: 다시 만들기는 노트 동기화(syncRegen)
   * 전까지 regenJobId 에만 걸려 있고(#616 Codex 2차), 동기화가 그 값을 지우면 lastRegenJobId 에 남는다(#639).
   * 이어받은 미리 만들기의 세트가 아직 없으면 'later'(다시 시도). 실패한 퀴즈 작업은 세트를 보지 않고 실패를 알린다.
   * 퀴즈 작업(유사 문제 · 퀴즈 만들기 · 미리 만들기)은 성공해도 쓸 문제를 하나도 못 만들면 세트가 failed 로 끝나므로
   * (#553, readyUpdate) 세트의 상태 · 문제 수를 보고 0개면 실패를 알린다(#634, #639)
   */
  private async contentOf(job: JobLean): Promise<
    | {
        title: string;
        body: string;
        threadId: string;
        data: { type: string; status: string } & Record<string, string>;
      }
    | 'later'
    | null
  > {
    if (SUMMARY_TYPES.includes(job.type)) {
      const material = await this.materials
        .findOne(
          { _id: job.targetId },
          {
            deletedAt: 1,
            title: 1,
            'processing.jobId': 1,
            'processing.regenJobId': 1,
            'processing.lastRegenJobId': 1,
          },
        )
        .lean<{
          deletedAt?: Date | null;
          title?: string | null;
          processing?: {
            jobId?: Types.ObjectId | null;
            regenJobId?: Types.ObjectId | null;
            lastRegenJobId?: Types.ObjectId | null;
          };
        } | null>();
      const id = String(job._id);
      const isJob = String(material?.processing?.jobId ?? '') === id;
      const isRegen = String(material?.processing?.regenJobId ?? '') === id;
      // 필드가 없는 옛 문서는 여기서 걸리지 않는다(지금처럼 옛 작업으로 본다)
      const isLastRegen = String(material?.processing?.lastRegenJobId ?? '') === id;
      if (!material || material.deletedAt || !(isJob || isRegen || isLastRegen)) return null;
      // 다시 만들기가 성공했어도 결과를 쓸 수 없으면 노트는 옛 결과 그대로다(syncRegen): 실패로 알린다.
      // 동기화 전(regenJobId)이든 노트를 먼저 열어 동기화가 끝낸 뒤(lastRegenJobId, #639)든 같은 판정이다
      const unusable = !isJob && job.status === 'succeeded' && !(await this.regenApplies(job));
      // 동기화가 끝낸 다시 만들기(lastRegenJobId)가 성공했고 쓸 수 있는 결과인데 jobId 가 아니면, 동기화 뒤에
      // 다시 시도(AiJobsService.retry)해 성공한 것이다: 노트에 반영되지 않으므로 알리지 않는다(지금처럼, code-review)
      if (!isJob && !isRegen && job.status === 'succeeded' && !unusable) return null;
      const status = unusable ? 'failed' : job.status;
      const materialId = String(job.targetId);
      return {
        title: MESSAGES.summary[status],
        body: material.title ?? '', // 제목이 없으면 본문은 비운다
        threadId: `note-summary-${materialId}`,
        data: { type: 'note-summary', materialId, status },
      };
    }
    const kind = job.type === SIMILAR_TYPE ? 'similar' : 'quiz';
    // 실패하면 세트가 안 생길 수 있다: 세트를 찾지 않고 바로 알린다(앱은 quizSetId가 없으면 퀴즈 탭으로 간다)
    const failed = () => ({
      title: MESSAGES[kind].failed,
      body: '퀴즈 탭에서 다시 만들 수 있어요', // 세트 제목을 모를 수 있다(알림함은 본문이 꼭 있어야 한다)
      threadId: `quiz-job-${String(job._id)}`,
      data: { type: 'quiz-ready', status: 'failed' },
    });
    if (job.status === 'failed') return failed();
    // 퀴즈 만들기 · 미리 만들기 모두 세트가 이 작업(jobId)을 가리킨다
    const set = await this.sets
      .findOne(
        { jobId: job._id, ownerId: job.userId, deletedAt: null },
        { title: 1, status: 1, questionCount: 1 },
      )
      .lean<{
        _id: Types.ObjectId;
        title?: string | null;
        status?: string | null;
        questionCount?: number | null;
      } | null>();
    // 미리 만들기는 이어받은(awaited) 뒤 세트를 만든다: 그 사이에 확인했으면 조금 뒤 다시 본다
    if (!set) return job.type === PREGEN_TYPE ? 'later' : null;
    if (!(await this.madeQuestions(job, set))) return failed();
    const quizSetId = String(set._id);
    return {
      title: MESSAGES[kind][job.status],
      body: set.title ?? '',
      threadId: `quiz-${quizSetId}`,
      data: { type: 'quiz-ready', quizSetId, status: job.status },
    };
  }

  /**
   * 성공한 다시 만들기 작업의 결과를 노트에 쓸 수 있는지. 노트 동기화(MaterialsService.syncRegen)와 같은 판정이다:
   * 처리 중으로 보고 syncFromJob 이 처리 완료(done)를 내면 결과를 바꾸고, 아니면 regenJobId 만 지워 옛 결과를 둔다
   */
  private async regenApplies(job: JobLean): Promise<boolean> {
    // 쪽 · 결과까지 읽으므로 동기화 전의 성공한 다시 만들기에서만 부른다
    const [material, full] = await Promise.all([
      this.materials.findOne({ _id: job.targetId }).lean<MaterialRow | null>(),
      this.jobs.findOne({ _id: job._id }, { status: 1, progress: 1, result: 1 }).lean<{
        status: string;
        progress?: number;
        result?: Record<string, unknown> | null;
      } | null>(),
    ]);
    if (!material || !full) return false;
    const update = syncFromJob(
      { ...material, processing: { ...material.processing, status: 'processing' } },
      {
        status: full.status,
        progress: full.progress ?? 0,
        result: full.result ?? null,
      } as AppAiJob,
    );
    return update?.['processing.status'] === 'done';
  }

  /**
   * 성공한 퀴즈 작업(유사 문제 #634 · 퀴즈 만들기 · 미리 만들기 #639)이 쓸 문제를 1개 이상 만들었는지.
   * 세트가 이미 ready 이고 문제가 있으면 그대로 믿는다. 그 밖에는(세트 동기화 전 generating · 0개라 failed ·
   * 앞선 실패로 failed 였다가 다시 시도해 성공) 세트 동기화가 결국 내릴 판정과 같도록 작업 결과를
   * 세트 동기화와 같은 규칙(resultQuestions: 유사 문제는 reviewQuestions, 그 밖은 questions)으로 센다
   */
  private async madeQuestions(
    job: JobLean,
    set: { status?: string | null; questionCount?: number | null },
  ): Promise<boolean> {
    if (set.status === 'ready' && (set.questionCount ?? 0) > 0) return true;
    const full = await this.jobs
      .findOne({ _id: job._id }, { type: 1, result: 1 })
      .lean<{ type: string; result?: Record<string, unknown> | null } | null>();
    return !!full && resultQuestions({ type: full.type, result: full.result ?? null }).length > 0;
  }

  /** 결과를 기록한다. 내 선점(claimId)일 때만 쓴다: 그사이 다시 시도로 notice가 지워졌으면 아무것도 바꾸지 않는다 */
  private async record(
    job: JobLean,
    claimId: string,
    outcome: Outcome,
    attempts: number,
    now: Date,
  ): Promise<void> {
    const mine = { _id: job._id, 'notice.claimId': claimId };
    if (outcome === 'retry' && attempts < NOTICE_MAX_ATTEMPTS) {
      const delay = NOTICE_RETRY_DELAYS_MS[attempts - 1] ?? NOTICE_RETRY_DELAYS_MS.at(-1)!;
      await this.jobs.updateOne(
        mine,
        { $set: { 'notice.state': null, 'notice.retryAt': new Date(now.getTime() + delay) } },
        NO_TIMESTAMPS,
      );
      return;
    }
    const state = outcome === 'retry' ? 'gave_up' : outcome;
    if (state === 'gave_up')
      this.logger.warn(
        `노트 변환 알림을 ${attempts}번 시도했지만 보내지 못해 포기해요(${String(job._id)})`,
      );
    await this.jobs.updateOne(mine, { $set: { 'notice.state': state } }, NO_TIMESTAMPS);
  }

  private logFailure(error: unknown): void {
    this.logger.warn(`노트 변환 알림 확인을 다시 시도해요: ${String(error)}`);
  }
}
