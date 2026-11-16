import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { type Model, Types } from 'mongoose';

import { Material } from '../modules/content/schemas/material.schema.js';
import {
  ExpoPushService,
  type ExpoPushMessage,
} from '../modules/notification/expo-push.service.js';
import { AiJob } from '../modules/quiz/schemas/ai-job.schema.js';
import { Device } from '../modules/users/schemas/device.schema.js';

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

const SUMMARY_TYPES = ['handwriting_summary', 'recording_summary', 'document_summary'];
const EXPO_PUSH_TOKEN = /^(?:Expo|Exponent)PushToken\[[^\]]+\]$/;
/** notice를 쓰는 모든 쓰기: updatedAt이 처리기가 끝낸 시각 그대로 남아야 30분 기준이 맞는다 */
const NO_TIMESTAMPS = { timestamps: false } as const;
/** 더 고르지 않는 최종 상태 */
const FINAL_STATES = ['sent', 'skipped', 'gave_up'];

const MESSAGES = {
  succeeded: '노트 정리가 끝났어요',
  failed: '노트 정리에 실패했어요. 다시 시도해 주세요',
} as const;

interface JobLean {
  _id: Types.ObjectId;
  status: 'succeeded' | 'failed';
  userId: Types.ObjectId;
  targetId: Types.ObjectId;
  notice?: { attempts?: number } | null;
}

/**
 * 노트 변환(요약 작업)이 끝나면 푸시로 알린다(FR-65-02). AI 처리기가 ai_jobs 상태를 DB에 직접 쓰므로 서버는
 * 끝난 시점을 스스로 알 수 없어, goal-reminders.service.ts처럼 주기적으로 끝난 작업을 찾아 보낸다.
 *
 * - status는 succeeded · failed만 본다. failed는 처리기가 자동 재시도 한도를 다 쓴 뒤에만 쓰는 최종 상태다
 *   (apps/ai jobs.py fail(): 중간에는 queued로 되돌린다). 그래서 failed를 보고 바로 알려도 된다.
 * - 작업마다 한 번: notice.claimId를 조건부 갱신으로 먼저 잡은 서버만 보낸다(서버가 여러 대여도 한 번).
 *   선점한 서버가 죽으면 NOTICE_LEASE_MS 뒤 다른 서버가 이어받는다(이때 기기에서는 collapseId로 하나로 합쳐진다).
 * - 보내기 직전에 작업을 다시 읽어, 그사이 다시 시도되어 상태가 바뀌었으면(retry가 notice를 지운다) 보내지 않는다.
 * - 노트가 지워졌거나 노트가 이 작업을 가리키지 않으면(다른 작업으로 다시 연결됨) 푸시 없이 skipped로 끝낸다.
 * - 기준 시각은 updatedAt이다(처리기가 끝낼 때 쓰고, 이후 이 서비스는 timestamps:false로만 쓴다).
 * - 무효 토큰 정리가 실패해도 발송은 성공으로 본다(재발송 금지). 발송이 전부 실패하면 NOTICE_MAX_ATTEMPTS까지 다시 시도한다.
 */
@Injectable()
export class AiJobNoticesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AiJobNoticesService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(AiJob.name) private readonly jobs: Model<AiJob>,
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly push: ExpoPushService,
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
  }

  /** 테스트와 운영 스케줄러가 공유하는 한 번의 확인. 겹쳐 부르면 뒤의 호출은 바로 끝난다 */
  async runOnce(startedAt?: Date, clock?: () => Date): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const tick = clock ?? (startedAt ? () => startedAt : () => new Date());
      let after: Types.ObjectId | null = null;
      for (;;) {
        const now = tick();
        const page: JobLean[] = await this.jobs
          .find(
            {
              ...(after ? { _id: { $gt: after } } : {}),
              type: { $in: SUMMARY_TYPES },
              targetType: 'material',
              status: { $in: ['succeeded', 'failed'] },
              updatedAt: { $gte: new Date(now.getTime() - NOTICE_WINDOW_MS) },
              'notice.state': { $nin: FINAL_STATES },
            },
            { status: 1, userId: 1, targetId: 1, notice: 1 },
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
    const attempts = (job.notice?.attempts ?? 0) + 1;
    if (attempts > NOTICE_MAX_ATTEMPTS) return;

    const claimId = randomUUID();
    const claimed = await this.jobs.updateOne(
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
            $or: [{ 'notice.attempts': null }, { 'notice.attempts': { $lt: NOTICE_MAX_ATTEMPTS } }],
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
      NO_TIMESTAMPS,
    );
    if (!claimed.matchedCount) return; // 다른 서버가 먼저 잡았다

    try {
      const outcome = await this.send(job, claimId, clock);
      if (outcome === 'abandoned') return; // 내 선점이 사라졌다(다시 시도됨): 아무것도 쓰지 않는다
      await this.record(job, claimId, outcome, attempts, clock());
    } catch (error) {
      this.logger.warn(`노트 변환 알림 발송 중 오류(${String(job._id)}): ${String(error)}`);
      await this.record(job, claimId, 'retry', attempts, clock());
    }
  }

  /** 확인하고 보낸다. 끝낼 상태(sent · skipped) / 다시 시도할 만한 실패(retry) / 내 선점이 사라짐(abandoned) */
  private async send(
    job: JobLean,
    claimId: string,
    clock: () => Date,
  ): Promise<'sent' | 'skipped' | 'retry' | 'abandoned'> {
    // 지운 노트 · 다른 작업에 다시 연결된 노트에는 보내지 않는다
    const material = await this.materials
      .findOne({ _id: job.targetId }, { deletedAt: 1, title: 1, 'processing.jobId': 1 })
      .lean<{
        deletedAt?: Date | null;
        title?: string | null;
        processing?: { jobId?: Types.ObjectId | null };
      } | null>();
    if (
      !material ||
      material.deletedAt ||
      String(material.processing?.jobId ?? '') !== String(job._id)
    )
      return 'skipped';

    const devices = await this.devices
      .find({ userId: job.userId }, { pushToken: 1 })
      .lean<{ pushToken: string }[]>();
    const tokens = [...new Set(devices.map((d) => d.pushToken))].filter((t) =>
      EXPO_PUSH_TOKEN.test(t),
    );
    if (!tokens.length) return 'sent'; // 기기가 없다

    // 선점 · 노트 · 기기 조회를 기다리는 사이 다시 시도되었을 수 있다: 내 선점과 상태가 그대로일 때만 보낸다
    const current = await this.jobs
      .findOne(
        {
          _id: job._id,
          status: job.status,
          'notice.claimId': claimId,
          updatedAt: { $gte: new Date(clock().getTime() - NOTICE_WINDOW_MS) },
        },
        { _id: 1 },
      )
      .lean();
    if (!current) return 'abandoned';

    const id = String(job._id);
    const materialId = String(job.targetId);
    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      title: MESSAGES[job.status],
      body: material.title ?? '', // 제목이 없으면 본문은 비운다
      data: { type: 'note-summary', materialId, status: job.status },
      sound: 'default',
      priority: 'high',
      collapseId: `ai-job-done:${id}`,
      threadId: `note-summary-${materialId}`,
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

  /** 결과를 기록한다. 내 선점(claimId)일 때만 쓴다: 그사이 다시 시도로 notice가 지워졌으면 아무것도 바꾸지 않는다 */
  private async record(
    job: JobLean,
    claimId: string,
    outcome: 'sent' | 'skipped' | 'retry',
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
