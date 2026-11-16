import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { TokenService } from '../modules/auth/token.service.js';
import { type AiJobProgress, AiJobsService, toProgress } from './ai-jobs.service.js';

/** 지켜보는 작업을 다시 읽는 간격. 앱의 대체 조회(1.5초, features/content/convert.tsx)보다 짧게 둔다 */
export const AI_PROGRESS_POLL_MS = 1000;
/** 처리기가 더 바꾸지 않는 상태. 이 상태가 되면 ai:done을 보내고 구독을 끝낸다 */
const FINISHED = new Set(['succeeded', 'failed', 'canceled']);
const ROOM_PREFIX = 'ai-job:';
const roomOf = (jobId: string) => `${ROOM_PREFIX}${jobId}`;
const signature = (p: AiJobProgress) => `${p.status}|${p.progress}|${p.step ?? ''}`;

/**
 * AI 작업 진행률 소켓(packages/shared `ai:subscribe` → `ai:progress` · `ai:done`).
 * 앱은 작업을 넣은 뒤 `ai:subscribe { jobId }`를 보낸다(features/content/convert.tsx · features/quiz/quiz.tsx).
 * 본인 작업이면 그 작업 방에 넣고 지금 상태를 바로 보낸다. 지켜보는 작업이 있는 동안에만 1초마다 상태 ·
 * 진행률만 한 번에 읽어(처리기는 ai_jobs에만 쓴다) 바뀌면 `ai:progress`, 끝나면 `GET /ai-jobs/:id`와 같은
 * 모양으로 `ai:done`을 보내고 방을 비운다. 변경 알림(change stream)은 로컬 단일 노드 MongoDB에서 쓸 수 없어 읽기로 한다.
 * 다시 연결되면 방이 사라지므로 앱이 다시 구독한다(hooks useAiJobSubscription). 화면을 떠나면 `ai:unsubscribe`.
 * 앱은 작업 조회(GET /ai-jobs/:id)로도 끝을 확인하므로 소켓이 끊겨도 결과는 놓치지 않는다.
 */
@Injectable()
@WebSocketGateway()
export class AiJobsGateway implements OnModuleDestroy {
  private readonly logger = new Logger(AiJobsGateway.name);
  /** 작업마다 마지막으로 보낸 값 · 주인. 같은 값은 다시 보내지 않는다 */
  private readonly watched = new Map<string, { userId: string; last?: string }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  @WebSocketServer() private server: Server;

  constructor(
    private readonly tokens: TokenService,
    private readonly jobs: AiJobsService,
  ) {}

  onModuleDestroy() {
    this.stop();
  }

  @SubscribeMessage('ai:subscribe')
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { jobId?: unknown },
  ): Promise<{ ok: boolean }> {
    const jobId = data?.jobId;
    if (typeof jobId !== 'string') return { ok: false };
    let userId: string;
    let job: Awaited<ReturnType<AiJobsService['findMine']>>;
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') return { ok: false };
      userId = (await this.tokens.verifyAccess(token)).userId;
      // 남의 작업 · 없는 작업 · 형식이 틀린 id는 모두 404라 같은 답을 준다
      job = await this.jobs.findMine(userId, jobId);
    } catch {
      return { ok: false };
    }
    if (FINISHED.has(job.status)) {
      socket.emit('ai:done', { jobId, job });
      return { ok: true };
    }
    await socket.join(roomOf(jobId));
    const progress = toProgress(job);
    socket.emit('ai:progress', progress);
    // 같은 작업을 다른 화면 · 기기가 이미 지켜보고 있으면 그 기록을 그대로 쓴다
    if (!this.watched.has(jobId)) this.watched.set(jobId, { userId, last: signature(progress) });
    this.start();
    return { ok: true };
  }

  /** 화면을 떠나면 그 작업 방에서 뺀다. 방이 비면 다음 차례에 더 읽지 않는다 */
  @SubscribeMessage('ai:unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() data: { jobId?: unknown }) {
    if (typeof data?.jobId === 'string') await socket.leave(roomOf(data.jobId));
  }

  /** 시험에서 기다리지 않고 한 번 돌린다. 겹쳐 돌지 않는다 */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.check();
    } catch (error) {
      // DB가 잠깐 안 될 때. 다음 차례에 다시 읽는다(앱은 작업 조회로도 확인한다)
      this.logger.warn(`AI 작업 진행률을 읽지 못했습니다: ${(error as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async check() {
    // 방에 아무도 없으면(앱 종료 · 연결 끊김) 더 읽지 않는다
    for (const jobId of this.watched.keys()) {
      if (!this.server.sockets.adapter.rooms.get(roomOf(jobId))?.size) this.watched.delete(jobId);
    }
    if (!this.watched.size) return this.stop();
    // 읽는 동안 새로 구독한 작업은 이번 결과에 없으므로, 보낸 id만 판단한다(다음 차례에 읽음)
    const asked = [...this.watched.keys()];
    const rows = await this.jobs.progressOf(asked);
    const found = new Set(rows.map((row) => row.jobId));
    for (const jobId of asked) {
      // 지운 작업(노트를 지움 등)은 더 지켜보지 않는다. 앱은 작업 조회의 404로 알게 된다
      if (!found.has(jobId)) this.finish(jobId);
    }
    const finished: Promise<void>[] = [];
    for (const row of rows) {
      const watch = this.watched.get(row.jobId);
      if (!watch) continue;
      if (FINISHED.has(row.status)) {
        // 끝난 작업은 결과를 다시 읽어야 해서, 남은 작업의 진행률을 늦추지 않게 함께 처리한다
        finished.push(this.done(row.jobId, watch.userId));
        continue;
      }
      const now = signature(row);
      if (watch.last === now) continue;
      watch.last = now;
      this.server.to(roomOf(row.jobId)).emit('ai:progress', row);
    }
    await Promise.all(finished);
  }

  /**
   * 결과(result)까지 보내므로, 구독한 뒤 토큰이 끝났거나 다른 계정으로 바뀐 소켓에는 보내지 않는다
   * (StudyChatGateway.notifyDirectMessage와 같은 방식). 진행률만 보내는 ai:progress는 확인하지 않는다
   */
  private async done(jobId: string, userId: string) {
    try {
      const job = await this.jobs.findMine(userId, jobId);
      const sockets = await this.server.in(roomOf(jobId)).fetchSockets();
      await Promise.all(
        sockets.map(async (recipient) => {
          try {
            const token = recipient.handshake.auth?.token;
            if (typeof token !== 'string') return;
            if ((await this.tokens.verifyAccess(token)).userId === userId)
              recipient.emit('ai:done', { jobId, job });
          } catch {
            // 토큰이 끝난 소켓. 앱은 작업 조회(GET /ai-jobs/:id)로 끝을 확인한다
          }
        }),
      );
    } catch {
      // 그사이 지워졌으면 보내지 않는다
    }
    this.finish(jobId);
  }

  private finish(jobId: string) {
    this.watched.delete(jobId);
    this.server.in(roomOf(jobId)).socketsLeave(roomOf(jobId));
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), AI_PROGRESS_POLL_MS);
    this.timer.unref?.();
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
