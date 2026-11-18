import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
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
/**
 * 끝난 작업을 보내다 일시 오류가 날 때(결과 읽기의 404 밖 오류 · 받는 소켓의 토큰 확인 중 DB 오류) 다시 해 보는
 * 차례 수. 넘으면 그만 지켜본다
 */
const DONE_RETRY_LIMIT = 5;
/** 지켜보는 작업 하나 */
interface Watch {
  userId: string;
  /** 마지막으로 보낸 진행률(signature). 같은 값은 다시 보내지 않는다 */
  last?: string;
  /** ai:done을 보낸 실행. 다시 시도하면 작업의 updatedAt이 바뀌므로 그 값으로 실행을 가린다 */
  run?: string;
  /** 이 실행에서 ai:done을 이미 받은 소켓. 일시 오류로 다시 보낼 때 건너뛴다 */
  delivered?: Set<string>;
  /** 이 실행에서 끝난 작업을 보내다 일시 오류가 난 수 */
  doneFailures?: number;
  /**
   * 다시 시도(AiJobsService.retry)될 때마다 늘린다. done()이 보내는 사이 바뀌면 읽은 결과는 앞 실행의 것일 수 있어
   * 보내지도 · 방에서 빼지도 않는다
   */
  generation: number;
}
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
  private readonly watched = new Map<string, Watch>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  /** 같은 소켓 · 작업의 구독과 해지를 받은 순서대로 처리한다(구독 확인 중에 온 해지가 먼저 끝나지 않게) */
  private readonly operations = new WeakMap<Socket, Map<string, Promise<unknown>>>();

  @WebSocketServer() private server: Server;

  /** 다시 시도 알림 등록을 푸는 함수 */
  private readonly offRetry: () => void;

  constructor(
    private readonly tokens: TokenService,
    private readonly jobs: AiJobsService,
  ) {
    this.offRetry = jobs.onRetry((jobId) => {
      const watch = this.watched.get(jobId);
      if (watch) watch.generation += 1;
    });
  }

  onModuleDestroy() {
    this.offRetry();
    this.stop();
  }

  private inOrder<T>(socket: Socket, key: string, operation: () => Promise<T>): Promise<T> {
    let jobs = this.operations.get(socket);
    if (!jobs) {
      jobs = new Map();
      this.operations.set(socket, jobs);
    }
    const current = (jobs.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    jobs.set(key, current);
    void current
      .finally(() => {
        if (jobs.get(key) === current) jobs.delete(key);
      })
      .catch(() => {});
    return current;
  }

  @SubscribeMessage('ai:subscribe')
  subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { jobId?: unknown },
  ): Promise<{ ok: boolean }> {
    const jobId = data?.jobId;
    if (typeof jobId !== 'string') return Promise.resolve({ ok: false });
    // ObjectId는 대소문자를 가리지 않으므로 순서 · 방 이름은 소문자로 맞춘다
    return this.inOrder(socket, jobId.toLowerCase(), () => this.join(socket, jobId));
  }

  private async join(socket: Socket, requested: string): Promise<{ ok: boolean }> {
    let userId: string;
    let job: Awaited<ReturnType<AiJobsService['findMine']>>;
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string') return { ok: false };
      userId = (await this.tokens.verifyAccess(token)).userId;
      // 남의 작업 · 없는 작업 · 형식이 틀린 id는 모두 404라 같은 답을 준다
      job = await this.jobs.findMine(userId, requested);
    } catch {
      return { ok: false };
    }
    // 방 · 지켜보기 키는 DB가 돌려주는 id(소문자)로 둔다. 반복해 읽은 결과(progressOf)와 같아야 한다
    const jobId = job._id;
    // 확인하는 사이 소켓이 끊겼으면 방에 넣지 않는다(끊긴 소켓을 넣으면 방에 남아 그 작업을 계속 읽음)
    if (!socket.connected) return { ok: false };
    if (FINISHED.has(job.status)) {
      socket.emit('ai:done', { jobId, job });
      return { ok: true };
    }
    await socket.join(roomOf(jobId));
    const progress = toProgress(job);
    socket.emit('ai:progress', progress);
    // 같은 작업을 다른 화면 · 기기가 이미 지켜보고 있으면 그 기록을 그대로 쓴다
    if (!this.watched.has(jobId))
      this.watched.set(jobId, { userId, last: signature(progress), generation: 0 });
    this.start();
    return { ok: true };
  }

  /** 화면을 떠나면 그 작업 방에서 뺀다. 방이 비면 다음 차례에 더 읽지 않는다 */
  @SubscribeMessage('ai:unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() data: { jobId?: unknown }) {
    if (typeof data?.jobId !== 'string') return;
    const jobId = data.jobId.toLowerCase();
    await this.inOrder(socket, jobId, () => Promise.resolve(socket.leave(roomOf(jobId))));
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
   * (StudyChatGateway.notifyDirectMessage와 같은 방식). 진행률만 보내는 ai:progress는 확인하지 않는다.
   * 결과는 토큰을 모두 확인한 뒤 보내기 바로 전에 읽는다. 먼저 읽으면 토큰을 확인하는 사이 다시 시도된 작업(같은 작업 id)의
   * 앞 실행 결과를 보내고, finish()로 다시 시도하며 다시 구독한 소켓까지 방에서 뺀다(#523). 앱(ConvertScreen.finish)은
   * 작업 id만 보므로 그 결과를 지금 실행의 실패로 받는다
   */
  private async done(jobId: string, userId: string) {
    // 시작할 때의 지켜보기 · 다시 시도 세대. 보내기 전에 바뀌었으면 이 처리는 앞 실행의 것이다
    const started = this.watched.get(jobId);
    const generation = started?.generation;
    let sockets: Awaited<ReturnType<ReturnType<Server['in']>['fetchSockets']>>;
    try {
      sockets = await this.server.in(roomOf(jobId)).fetchSockets();
    } catch (error) {
      return this.retryLater(jobId, error);
    }
    const allowed: typeof sockets = [];
    // 토큰 확인 중 DB 일시 오류가 난 소켓. 이미 받은 소켓이 아니면 다음 차례에 다시 보낸다
    const transient = new Map<string, unknown>();
    await Promise.all(
      sockets.map(async (recipient) => {
        try {
          const token = recipient.handshake.auth?.token;
          if (typeof token !== 'string') return;
          if ((await this.tokens.verifyAccess(token)).userId === userId) allowed.push(recipient);
        } catch (error) {
          // 토큰이 끝난 소켓(401)은 보내지 않는다. 앱은 작업 조회(GET /ai-jobs/:id)로 끝을 확인한다
          if (!(error instanceof UnauthorizedException)) transient.set(recipient.id, error);
        }
      }),
    );
    let job: Awaited<ReturnType<AiJobsService['findMine']>>;
    try {
      job = await this.jobs.findMine(userId, jobId);
    } catch (error) {
      // 그사이 지워졌으면 더 지켜보지 않는다. DB 일시 오류면 그대로 두어 다음 차례에 다시 보낸다
      if (error instanceof NotFoundException) this.finish(jobId);
      else this.retryLater(jobId, error);
      return;
    }
    const watch = this.watched.get(jobId);
    // 끝나지 않았거나(다시 시도로 처리기에 다시 들어감) 그사이 다시 시도됐으면(결과 읽기가 다시 시도를 쓰기 전에 나갔을 수
    // 있음) 보내지도 · 방에서 빼지도 않고 계속 지켜본다. 다시 시도하며 다시 구독한 소켓 · 다른 기기가 새 실행을 받게 한다.
    // 이 검사 뒤에는 기다리지 않고 보내므로, 다시 시도 응답이 나간 뒤에 앞 실행의 결과가 나가지 않는다
    if (!FINISHED.has(job.status) || watch !== started || watch?.generation !== generation) {
      if (watch) watch.last = undefined;
      return;
    }
    // 실행이 바뀌었으면(다시 시도된 작업이 다시 끝남) 앞 실행의 보낸 기록 · 실패 수를 버린다.
    // 다시 시도를 진행 중 상태로 보지 못하고 바로 끝난 상태로 읽어도 맞게, 실행은 작업의 updatedAt으로 가린다
    if (watch && watch.run !== job.updatedAt) {
      watch.run = job.updatedAt;
      watch.delivered = new Set();
      watch.doneFailures = undefined;
      // 다시 시도되면 진행률을 처음부터 다시 보내게 한다
      watch.last = undefined;
    }
    const delivered = watch?.delivered ?? new Set<string>();
    for (const recipient of allowed) {
      // 앞 차례에 이미 보낸 소켓 · 확인하는 사이 해지(ai:unsubscribe)한 소켓에는 보내지 않는다.
      // 해지한 뒤 다시 구독하면 join()이 끝난 결과를 바로 보낸다
      if (delivered.has(recipient.id) || !this.inRoom(recipient.id, jobId)) continue;
      recipient.emit('ai:done', { jobId, job });
      delivered.add(recipient.id);
    }
    // 그사이 해지해 방을 떠난 소켓의 일시 오류는 다시 보낼 곳이 없으므로 세지 않는다
    const failed = [...transient].find(([id]) => !delivered.has(id) && this.inRoom(id, jobId));
    if (failed) return this.retryLater(jobId, failed[1]);
    // 처음 목록의 소켓만 방에서 뺀다. 토큰을 확인하는 사이 들어온 소켓(다시 시도된 새 실행을 구독)은 남겨 다음 차례에
    // 보낸다. 방이 비었으면 지켜보기도 지운다
    for (const recipient of sockets) void recipient.leave(roomOf(jobId));
    if (!this.server.sockets.adapter.rooms.get(roomOf(jobId))?.size) this.watched.delete(jobId);
  }

  /**
   * 소켓이 지금 그 작업 방에 있는가. 이 서버에 없는 소켓(그사이 끊김 · 다른 서버)은 알 수 없어 있는 것으로 본다
   * (끊긴 소켓에는 보내도 닿지 않는다)
   */
  private inRoom(socketId: string, jobId: string) {
    const socket = this.server.sockets.sockets.get(socketId);
    return !socket || socket.rooms.has(roomOf(jobId));
  }

  /** 일시 오류로 끝난 작업을 보내지 못했다. 지켜보기를 유지해 다음 차례에 다시 보내고, 계속 실패하면 그만둔다 */
  private retryLater(jobId: string, error: unknown) {
    const watch = this.watched.get(jobId);
    const failures = (watch?.doneFailures ?? 0) + 1;
    if (!watch || failures >= DONE_RETRY_LIMIT) this.finish(jobId);
    else watch.doneFailures = failures;
    this.logger.warn(
      `끝난 AI 작업을 보내지 못했습니다(${failures}번째): ${(error as Error)?.message ?? error}`,
    );
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
