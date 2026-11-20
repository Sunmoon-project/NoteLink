import { type INestApplication, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiJobsGateway } from '../src/ai-jobs/ai-jobs.gateway.js';
import {
  type AiJobProgress,
  type AppAiJob,
  AiJobsService,
} from '../src/ai-jobs/ai-jobs.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';

const JOB = '64b000000000000000000001';
const OTHER_JOB = '64b000000000000000000002';

const appJob = (over: Partial<AppAiJob> = {}): AppAiJob => ({
  _id: JOB,
  type: 'handwriting_summary',
  status: 'running',
  targetType: 'material',
  targetId: '64b0000000000000000000aa',
  progress: 10,
  attempts: 1,
  step: 'ocr',
  result: null,
  error: null,
  createdAt: '2026-11-16T00:00:00.000Z',
  updatedAt: '2026-11-16T00:00:00.000Z',
  ...over,
});

/** 작업 주인은 a. 상태는 시험이 jobs 표를 바꿔 처리기가 쓴 것처럼 만든다 */
const table = new Map<string, AppAiJob>();
/** 게이트웨이가 등록한 다시 시도 알림(AiJobsService.onRetry) */
const retryListeners = new Set<(jobId: string) => void>();
const jobs = {
  onRetry: vi.fn((listener: (jobId: string) => void) => {
    retryListeners.add(listener);
    return () => retryListeners.delete(listener);
  }),
  // 실제 서비스처럼 ObjectId는 대소문자를 가리지 않는다
  findMine: vi.fn(async (userId: string, jobId: string) => {
    const job = table.get(jobId.toLowerCase());
    if (!job || userId !== 'a') throw new NotFoundException();
    return job;
  }),
  progressOf: vi.fn(async (ids: string[]): Promise<AiJobProgress[]> =>
    ids.flatMap((id) => {
      const job = table.get(id);
      if (!job) return [];
      const p: AiJobProgress = { jobId: id, status: job.status, progress: job.progress };
      if (job.step !== undefined) p.step = job.step;
      return [p];
    }),
  ),
};
/** 앱의 다시 시도(AiJobsService.retry): 같은 작업 id를 새 실행으로 바꾸고, 응답하기 전에 게이트웨이에 알린다 */
const retryJob = (job: AppAiJob) => {
  table.set(job._id, job);
  retryListeners.forEach((listener) => listener(job._id));
};
const tokens = { verifyAccess: vi.fn() };

let app: INestApplication;
let gateway: AiJobsGateway;
let url: string;
const sockets: Socket[] = [];

async function connect(token: string) {
  const socket = io(url, { transports: ['websocket'], auth: { token }, forceNew: true });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function record(socket: Socket) {
  const progress: AiJobProgress[] = [];
  const done: { jobId: string; job: AppAiJob }[] = [];
  socket.on('ai:progress', (p: AiJobProgress) => progress.push(p));
  socket.on('ai:done', (d: { jobId: string; job: AppAiJob }) => done.push(d));
  return { progress, done };
}

const subscribe = (socket: Socket, jobId: unknown = JOB) =>
  socket.timeout(1000).emitWithAck('ai:subscribe', { jobId }) as Promise<{ ok: boolean }>;

/** 소켓 이벤트가 도착할 틈을 준다 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** 시험이 붙잡아 둔 DB 읽기 · 토큰 확인. 시험이 중간에 실패해도 다음 시험 전에 모두 푼다(붙잡힌 poll이 다음 시험을 막지 않게) */
const held: (() => void)[] = [];
const blocked = (assign: (release: () => void) => void) =>
  new Promise<void>((resolve) => {
    held.push(resolve);
    assign(resolve);
  });

beforeAll(async () => {
  const module = await Test.createTestingModule({
    providers: [
      AiJobsGateway,
      { provide: AiJobsService, useValue: jobs },
      { provide: TokenService, useValue: tokens },
    ],
  }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  gateway = app.get(AiJobsGateway);
  url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  // 붙잡아 둔 한 번짜리 구현(mockImplementationOnce)이 다음 시험으로 넘어가지 않게 처음 구현으로 되돌린다
  vi.resetAllMocks();
  table.clear();
  table.set(JOB, appJob());
  tokens.verifyAccess.mockImplementation(async (token: string) => {
    // 실제 TokenService처럼 거절은 UnauthorizedException
    if (token === 'bad') throw new UnauthorizedException();
    return { userId: token };
  });
});
afterEach(async () => {
  held.splice(0).forEach((release) => release());
  sockets.splice(0).forEach((s) => s.disconnect());
  await settle();
  // 남은 구독(끊긴 소켓)을 비운다
  await gateway.poll();
});

describe('AI 작업 진행률 소켓 (ai:subscribe)', () => {
  it('본인 작업을 구독하면 지금 상태를 바로 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(got.progress).toEqual([{ jobId: JOB, status: 'running', progress: 10, step: 'ocr' }]),
    );
    expect(jobs.findMine).toHaveBeenCalledWith('a', JOB);
  });

  it('바뀐 진행률만 보내고, 같은 값은 다시 보내지 않는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    await gateway.poll();
    await settle();
    expect(got.progress).toHaveLength(1);

    table.set(JOB, appJob({ progress: 55, step: 'summary' }));
    await gateway.poll();
    await vi.waitFor(() =>
      expect(got.progress.at(-1)).toEqual({
        jobId: JOB,
        status: 'running',
        progress: 55,
        step: 'summary',
      }),
    );
    expect(got.progress).toHaveLength(2);
  });

  it('끝나면 작업 조회와 같은 모양으로 ai:done을 보내고 더 읽지 않는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    const finished = appJob({ status: 'succeeded', progress: 100, result: { ok: true } });
    table.set(JOB, finished);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: finished }]));

    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('이미 끝난 작업을 구독하면 바로 ai:done을 보내고 지켜보지 않는다', async () => {
    const failed = appJob({ status: 'failed', error: 'AI_JOB_FAILED' });
    table.set(JOB, failed);
    const a = await connect('a');
    const got = record(a);
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: failed }]));
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
    expect(got.progress).toEqual([]);
  });

  it.each([
    ['남의 작업', 'b', JOB],
    ['없는 작업', 'a', OTHER_JOB],
    ['문자열이 아닌 id', 'a', 123],
    ['검증에 실패한 토큰', 'bad', JOB],
  ])('%s은 구독하지 않는다', async (_name, token, jobId) => {
    const socket = await connect(token);
    const got = record(socket);
    await expect(subscribe(socket, jobId)).resolves.toEqual({ ok: false });
    table.set(JOB, appJob({ progress: 70 }));
    await gateway.poll();
    await settle();
    expect(got).toEqual({ progress: [], done: [] });
  });

  it('남의 작업 방의 진행률은 다른 사용자에게 가지 않는다', async () => {
    const a = await connect('a');
    const b = await connect('b');
    const gotB = record(b);
    await subscribe(a);
    await subscribe(b);
    table.set(JOB, appJob({ progress: 80 }));
    await gateway.poll();
    await settle();
    expect(gotB).toEqual({ progress: [], done: [] });
  });

  it('같은 작업을 두 소켓이 지켜보면 둘 다 받는다', async () => {
    const one = await connect('a');
    const two = await connect('a');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    table.set(JOB, appJob({ progress: 90 }));
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got1.progress.at(-1)?.progress).toBe(90);
      expect(got2.progress.at(-1)?.progress).toBe(90);
    });
  });

  it('지켜보던 소켓이 모두 끊기면 더 읽지 않는다', async () => {
    const a = await connect('a');
    await subscribe(a);
    a.disconnect();
    await settle();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('작업이 지워지면 더 지켜보지 않는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.delete(JOB);
    await gateway.poll();
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
    expect(got.done).toEqual([]);
  });

  it('읽기가 한 번 실패해도 다음 차례에 이어서 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    jobs.progressOf.mockRejectedValueOnce(new Error('db down'));
    await expect(gateway.poll()).resolves.toBeUndefined();
    table.set(JOB, appJob({ progress: 40 }));
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(40));
  });

  it('읽는 동안 새로 구독한 작업은 지운 작업으로 보지 않는다', async () => {
    const SECOND = '64b000000000000000000003';
    table.set(SECOND, appJob({ _id: SECOND, progress: 5 }));
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    // 첫 작업을 읽는 도중에 두 번째 작업을 구독한다
    let release!: () => void;
    jobs.progressOf.mockImplementationOnce(async (ids: string[]) => {
      await new Promise<void>((resolve) => (release = resolve));
      return ids.map((id) => ({ jobId: id, status: 'running', progress: 10, step: 'ocr' }));
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await subscribe(a, SECOND);
    release();
    await polling;
    table.set(SECOND, appJob({ _id: SECOND, progress: 60 }));
    await gateway.poll();
    await vi.waitFor(() =>
      expect(got.progress.filter((p) => p.jobId === SECOND).at(-1)?.progress).toBe(60),
    );
  });

  it('ai:unsubscribe 뒤에는 그 작업의 진행률을 받지 않고, 방이 비면 더 읽지 않는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    a.emit('ai:unsubscribe', { jobId: JOB });
    await settle();
    table.set(JOB, appJob({ progress: 77 }));
    await gateway.poll();
    await settle();
    expect(got.progress.map((p) => p.progress)).toEqual([10]);
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('구독한 뒤 토큰이 끝난 소켓에는 결과(ai:done)를 보내지 않는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    tokens.verifyAccess.mockRejectedValue(new UnauthorizedException());
    table.set(JOB, appJob({ status: 'succeeded', progress: 100, result: { secret: true } }));
    await gateway.poll();
    await settle();
    expect(got.done).toEqual([]);
  });

  it('여러 작업이 함께 끝나도 남은 작업의 진행률을 같이 보낸다', async () => {
    const SECOND = '64b000000000000000000003';
    table.set(SECOND, appJob({ _id: SECOND, progress: 5 }));
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    await subscribe(a, SECOND);
    table.set(JOB, appJob({ status: 'succeeded', progress: 100 }));
    table.set(SECOND, appJob({ _id: SECOND, progress: 50 }));
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got.done.map((d) => d.jobId)).toEqual([JOB]);
      expect(got.progress.filter((p) => p.jobId === SECOND).at(-1)?.progress).toBe(50);
    });
  });

  it('끝난 것을 읽은 사이 다시 시도로 처리기에 다시 들어가면 끝내지 않고 계속 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    // 진행률 읽기는 실패를 보고, 결과를 다시 읽을 때는 이미 다시 시도(queued)
    jobs.progressOf.mockResolvedValueOnce([{ jobId: JOB, status: 'failed', progress: 30 }]);
    table.set(JOB, appJob({ status: 'queued', progress: 0, step: undefined }));
    await gateway.poll();
    await settle();
    expect(got.done).toEqual([]);
    table.set(JOB, appJob({ status: 'running', progress: 15, step: 'ocr' }));
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(15));
  });

  it('끝난 작업의 결과를 읽다가 DB가 잠깐 안 되면 지켜보기를 유지하고 다음 차례에 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    const finished = appJob({ status: 'succeeded', progress: 100 });
    table.set(JOB, finished);
    jobs.findMine.mockRejectedValueOnce(new Error('db down'));
    await gateway.poll();
    await settle();
    expect(got.done).toEqual([]);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: finished }]));
  });

  it('받는 소켓의 토큰 확인이 DB 일시 오류로 실패하면 다음 차례에 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    const finished = appJob({ status: 'succeeded', progress: 100 });
    table.set(JOB, finished);
    tokens.verifyAccess.mockRejectedValueOnce(new Error('db down'));
    await gateway.poll();
    await settle();
    expect(got.done).toEqual([]);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: finished }]));
    // 보낸 뒤에는 더 지켜보지 않는다
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('두 소켓 중 하나만 일시 오류면 다음 차례에 그 소켓에만 보낸다', async () => {
    // 두 소켓 모두 사용자 a (토큰 'a' · 'a2')
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    table.set(JOB, appJob({ status: 'succeeded', progress: 100 }));
    let failedOnce = false;
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a2' && !failedOnce) {
        failedOnce = true;
        throw new Error('db down');
      }
      return { userId: 'a' };
    });
    await gateway.poll();
    await gateway.poll();
    await settle();
    // 처음 받은 소켓은 다시 받지 않는다
    expect(got1.done).toHaveLength(1);
    expect(got2.done).toHaveLength(1);
  });

  it('이미 받은 소켓의 토큰 확인이 일시 오류여도 남은 소켓에 보냈으면 끝낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    table.set(JOB, appJob({ status: 'succeeded', progress: 100 }));
    // 첫 차례는 two가, 다음 차례는 (이미 받은) one이 일시 오류
    let failing = 'a2';
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === failing) throw new Error('db down');
      return { userId: 'a' };
    });
    await gateway.poll();
    await vi.waitFor(() => expect(got1.done).toHaveLength(1));
    failing = 'a';
    await gateway.poll();
    await vi.waitFor(() => expect(got2.done).toHaveLength(1));
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
    expect(got1.done).toHaveLength(1);
  });

  it('보낸 기록이 남은 작업을 다시 시도하면 새 결과는 모든 소켓에 다시 보낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    // 첫 실행: one은 받고 two는 토큰 확인이 일시 오류
    table.set(JOB, appJob({ status: 'failed', progress: 30 }));
    let failTwo = true;
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a2' && failTwo) throw new Error('db down');
      return { userId: 'a' };
    });
    await gateway.poll();
    await vi.waitFor(() => expect(got1.done).toHaveLength(1));
    // 다시 시도로 처리기에 다시 들어감 → 다음 차례에 끝나지 않은 것을 봄
    table.set(JOB, appJob({ status: 'queued', progress: 0 }));
    jobs.progressOf.mockResolvedValueOnce([{ jobId: JOB, status: 'failed', progress: 30 }]);
    await gateway.poll();
    // 두 번째 실행이 끝남
    failTwo = false;
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:05:00.000Z',
    });
    table.set(JOB, second);
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got1.done.at(-1)).toEqual({ jobId: JOB, job: second });
      expect(got2.done.at(-1)).toEqual({ jobId: JOB, job: second });
    });
    expect(got1.done.filter((d) => d.job.updatedAt === second.updatedAt)).toHaveLength(1);
    expect(got2.done.filter((d) => d.job.updatedAt === second.updatedAt)).toHaveLength(1);
  });

  it('다시 시도된 작업을 진행 중(queued)으로 먼저 읽어도 새 결과는 모든 소켓에 보낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    table.set(JOB, appJob({ status: 'failed', progress: 30 }));
    let failTwo = true;
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a2' && failTwo) throw new Error('db down');
      return { userId: 'a' };
    });
    await gateway.poll();
    await vi.waitFor(() => expect(got1.done).toHaveLength(1));
    // 다시 시도: 1초마다 읽는 쪽이 queued를 그대로 본다
    table.set(JOB, appJob({ status: 'queued', progress: 0 }));
    await gateway.poll();
    failTwo = false;
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:05:00.000Z',
    });
    table.set(JOB, second);
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got1.done.at(-1)).toEqual({ jobId: JOB, job: second });
      expect(got2.done.at(-1)).toEqual({ jobId: JOB, job: second });
    });
    expect(got1.done.filter((d) => d.job.updatedAt === second.updatedAt)).toHaveLength(1);
    expect(got2.done.filter((d) => d.job.updatedAt === second.updatedAt)).toHaveLength(1);
  });

  it('다시 시도가 두 번 읽는 사이에 시작해 끝나도 새 결과는 모든 소켓에 보낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    table.set(JOB, appJob({ status: 'failed', progress: 30 }));
    let failTwo = true;
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a2' && failTwo) throw new Error('db down');
      return { userId: 'a' };
    });
    await gateway.poll();
    await vi.waitFor(() => expect(got1.done).toHaveLength(1));
    // 진행 중 상태를 한 번도 보지 못하고, 다음 차례에 이미 끝난 두 번째 실행을 읽는다
    failTwo = false;
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:05:00.000Z',
    });
    table.set(JOB, second);
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got1.done.at(-1)).toEqual({ jobId: JOB, job: second });
      expect(got2.done.at(-1)).toEqual({ jobId: JOB, job: second });
    });
    expect(got1.done).toHaveLength(2);
    expect(got2.done).toHaveLength(1);
  });

  /** 다음 토큰 확인(끝난 작업을 보내는 done) 하나를 release까지 붙잡아 둔다 */
  const holdNextVerify = () => {
    const hold: { release?: () => void } = {};
    const original = tokens.verifyAccess.getMockImplementation()!;
    tokens.verifyAccess.mockImplementationOnce(async (token: string) => {
      await blocked((release) => (hold.release = release));
      return original(token);
    });
    return hold;
  };

  it('실패 결과의 토큰 확인을 기다리는 사이 다시 시도 · 다시 구독하면 앞 실행의 결과를 보내지 않고 새 구독을 지킨다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' }));
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    // 앱: 다시 시도(같은 작업 id, updatedAt이 바뀜) → 훅이 해지한 뒤 다시 구독한다(hooks useAiJobSubscription)
    retryJob(
      appJob({
        status: 'queued',
        progress: 0,
        step: undefined,
        updatedAt: '2026-11-16T00:05:00.000Z',
      }),
    );
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    hold.release!();
    await polling;
    await settle();
    // 앞 실행의 실패를 받으면 앱(ConvertScreen.finish)은 지금 실행이 실패한 것으로 본다
    expect(got.done).toEqual([]);
    // 새 구독이 방에 남아 새 실행의 진행률 · 결과를 받는다
    table.set(JOB, appJob({ progress: 15, updatedAt: '2026-11-16T00:05:00.000Z' }));
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(15));
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:06:00.000Z',
    });
    table.set(JOB, second);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: second }]));
  });

  it('결과 읽기가 다시 시도를 쓰기 전에 나가 다시 구독을 마친 뒤에 돌아와도 앞 실행의 결과를 보내지 않고 새 구독을 지킨다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const a = await connect('a');
    // 같은 사용자의 다른 기기: 다시 시도하지 않아 다시 구독하지도 않는다
    const other = await connect('a2');
    const got = record(a);
    const gotOther = record(other);
    await subscribe(a);
    await subscribe(other);
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' }));
    // done()의 결과 읽기: 다시 시도 전의 값(failed)을 읽은 채 응답만 늦게 온다
    let releaseRead!: () => void;
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockImplementationOnce(async (userId: string, jobId: string) => {
      const before = await original(userId, jobId);
      await blocked((release) => (releaseRead = release));
      return before;
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    retryJob(
      appJob({
        status: 'queued',
        progress: 0,
        step: undefined,
        updatedAt: '2026-11-16T00:05:00.000Z',
      }),
    );
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    releaseRead();
    await polling;
    await settle();
    expect(got.done).toEqual([]);
    expect(gotOther.done).toEqual([]);
    // 두 소켓 모두 방에 남아 새 실행의 진행률을 받는다
    table.set(JOB, appJob({ progress: 15, updatedAt: '2026-11-16T00:05:00.000Z' }));
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got.progress.at(-1)?.progress).toBe(15);
      expect(gotOther.progress.at(-1)?.progress).toBe(15);
    });
  });

  it('일시 오류가 쌓인 뒤 결과 읽기를 기다리는 사이 다시 시도 · 다시 구독되고 그 읽기가 실패해도 새 구독을 지킨다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' }));
    // 결과 읽기가 4번 일시 오류(한도 5번의 바로 앞)
    jobs.findMine
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'));
    for (let i = 0; i < 4; i++) await gateway.poll();
    // 다섯 번째 읽기: 기다리는 사이 다시 시도 · 다시 구독, 그 뒤 일시 오류로 실패
    let releaseRead!: () => void;
    jobs.findMine.mockImplementationOnce(async () => {
      await blocked((release) => (releaseRead = release));
      throw new Error('db down');
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    retryJob(
      appJob({
        status: 'queued',
        progress: 0,
        step: undefined,
        updatedAt: '2026-11-16T00:05:00.000Z',
      }),
    );
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    releaseRead();
    await polling;
    // 앞 실행의 일시 오류로 그만 지켜보지 않는다: 새 실행의 진행률을 받는다
    table.set(JOB, appJob({ progress: 15, updatedAt: '2026-11-16T00:05:00.000Z' }));
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(15));
    expect(got.done).toEqual([]);
  });

  it('앞 실행에서 쌓인 일시 오류 수는 다시 시도하면 처음부터 센다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' }));
    // 앞 실행: 결과 읽기가 4번 일시 오류(한도 5번의 바로 앞)
    for (let i = 0; i < 4; i++) {
      jobs.findMine.mockRejectedValueOnce(new Error('db down'));
      await gateway.poll();
    }
    retryJob(
      appJob({
        status: 'queued',
        progress: 0,
        step: undefined,
        updatedAt: '2026-11-16T00:05:00.000Z',
      }),
    );
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    // 새 실행이 끝났는데 결과 읽기가 한 번 일시 오류 → 그만 지켜보지 않고 다음 차례에 보낸다
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:06:00.000Z',
    });
    table.set(JOB, second);
    jobs.findMine.mockRejectedValueOnce(new Error('db down'));
    await gateway.poll();
    await settle();
    expect(got.done).toEqual([]);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: second }]));
  });

  it('다시 구독을 확인하는 중에 앞 실행의 토큰 확인이 끝나도 그 소켓에 앞 결과를 보내지 않는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' }));
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    retryJob(
      appJob({
        status: 'queued',
        progress: 0,
        step: undefined,
        updatedAt: '2026-11-16T00:05:00.000Z',
      }),
    );
    // 다시 구독의 작업 확인을 붙잡아, 앞 실행의 보내기가 구독 확인 도중에 끝나게 한다
    let releaseJoin!: () => void;
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockImplementationOnce(async (userId: string, jobId: string) => {
      await blocked((release) => (releaseJoin = release));
      return original(userId, jobId);
    });
    a.emit('ai:unsubscribe', { jobId: JOB });
    const joining = subscribe(a);
    await vi.waitFor(() => expect(releaseJoin).toBeTypeOf('function'));
    hold.release!();
    await polling;
    await settle();
    expect(got.done).toEqual([]);
    releaseJoin();
    await expect(joining).resolves.toEqual({ ok: true });
    table.set(JOB, appJob({ progress: 15, updatedAt: '2026-11-16T00:05:00.000Z' }));
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(15));
    expect(got.done).toEqual([]);
  });

  it('보내는 중에 같은 실행을 다른 소켓이 다시 구독해도(다시 연결 등) 그 차례에 보내고 끝낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    const finished = appJob({ status: 'succeeded', progress: 100 });
    table.set(JOB, finished);
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    // 작업은 그대로 끝난 상태에서 two가 다시 구독 → 구독에서 바로 결과를 받는다
    await subscribe(two);
    await vi.waitFor(() => expect(got2.done).toHaveLength(1));
    hold.release!();
    await polling;
    // 다음 차례를 기다리지 않고 이번 차례에 보낸다
    await vi.waitFor(() => expect(got1.done).toEqual([{ jobId: JOB, job: finished }]));
    await settle();
    // two는 방에 남아 있어 이번 차례에도 받는다(구독에서 받은 것과 같은 결과. 앱은 같은 결과를 한 번만 처리)
    expect(got2.done).toEqual([
      { jobId: JOB, job: finished },
      { jobId: JOB, job: finished },
    ]);
    expect(got1.done).toHaveLength(1);
    // 끝난 뒤에는 더 지켜보지 않는다
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('앞 실행의 토큰 확인을 기다리는 사이 다시 시도된 실행이 곧바로 끝나면 새 결과만 받는다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const a = await connect('a');
    // 같은 사용자의 다른 기기: 다시 구독하지 않고 방에 그대로 남는다
    const other = await connect('a2');
    const got = record(a);
    const gotOther = record(other);
    await subscribe(a);
    await subscribe(other);
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' }));
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:05:00.000Z',
    });
    retryJob(second);
    a.emit('ai:unsubscribe', { jobId: JOB });
    await subscribe(a);
    hold.release!();
    await polling;
    await gateway.poll();
    await settle();
    // 새 성공 뒤에 · 새 성공 대신 앞 실행의 실패가 오지 않는다
    expect(got.done.map((d) => d.job.status)).toEqual(['succeeded']);
    expect(gotOther.done).toEqual([{ jobId: JOB, job: second }]);
  });

  it('토큰 확인을 기다리는 사이 다시 시도된 실행이 같은 상태(실패)로 끝나면 새 실행의 결과를 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'NO_SPEECH' }));
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    const again = appJob({
      status: 'failed',
      progress: 0,
      error: 'INVALID_FILE',
      updatedAt: '2026-11-16T00:05:00.000Z',
    });
    retryJob(again);
    hold.release!();
    await polling;
    // 다시 시도된 사이의 처리는 버리고 다음 차례에 새 실행의 결과를 보낸다
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: again }]));
  });

  it('토큰을 확인하는 사이 해지한 소켓에는 결과를 보내지 않는다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    const got2 = record(two);
    await subscribe(one);
    await subscribe(two);
    const finished = appJob({ status: 'succeeded', progress: 100 });
    table.set(JOB, finished);
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    one.emit('ai:unsubscribe', { jobId: JOB });
    await settle();
    hold.release!();
    await polling;
    await settle();
    expect(got1.done).toEqual([]);
    expect(got2.done).toEqual([{ jobId: JOB, job: finished }]);
  });

  it('보낼 소켓이 없어도(남은 소켓이 401) 그사이 다시 시도 · 다시 구독한 소켓은 방에서 빼지 않는다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    await subscribe(one);
    await subscribe(two);
    // 첫 차례: one은 받고 two는 토큰 확인이 일시 오류 → 지켜보기 유지
    table.set(JOB, appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' }));
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a2') throw new Error('db down');
      return { userId: 'a' };
    });
    await gateway.poll();
    await vi.waitFor(() => expect(got1.done).toHaveLength(1));
    // 다음 차례: two의 토큰 확인을 붙잡은 사이 one이 다시 시도 · 다시 구독. two는 그 뒤 401
    let releaseTwo!: () => void;
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a2') {
        await blocked((release) => (releaseTwo = release));
        throw new UnauthorizedException();
      }
      return { userId: 'a' };
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(releaseTwo).toBeTypeOf('function'));
    retryJob(
      appJob({
        status: 'queued',
        progress: 0,
        step: undefined,
        updatedAt: '2026-11-16T00:05:00.000Z',
      }),
    );
    one.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(one)).resolves.toEqual({ ok: true });
    releaseTwo();
    await polling;
    table.set(JOB, appJob({ progress: 15, updatedAt: '2026-11-16T00:05:00.000Z' }));
    await gateway.poll();
    await vi.waitFor(() => expect(got1.progress.at(-1)?.progress).toBe(15));
    expect(got1.done).toHaveLength(1);
  });

  it('토큰을 확인하는 사이 새로 구독한 소켓은 방에서 빼지 않고 다음 차례에 결과를 보낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const got1 = record(one);
    await subscribe(one);
    const finished = appJob({ status: 'succeeded', progress: 100 });
    table.set(JOB, finished);
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    // 다른 기기(two)의 구독이 끝나기 직전의 상태(running)를 읽고 방에 들어간다
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockImplementationOnce(async (userId: string, jobId: string) => ({
      ...(await original(userId, jobId)),
      status: 'running',
      progress: 90,
    }));
    const two = await connect('a2');
    const got2 = record(two);
    await expect(subscribe(two)).resolves.toEqual({ ok: true });
    hold.release!();
    await polling;
    await vi.waitFor(() => expect(got1.done).toEqual([{ jobId: JOB, job: finished }]));
    await settle();
    expect(got2.done).toEqual([]);
    // 처음 목록에 없던 two는 방에 남아 다음 차례에 받는다
    await gateway.poll();
    await vi.waitFor(() => expect(got2.done).toEqual([{ jobId: JOB, job: finished }]));
    // 모두 받은 뒤에는 더 지켜보지 않는다
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
    expect(got1.done).toHaveLength(1);
  });

  it('토큰 확인이 일시 오류인 소켓이 그사이 해지했으면 다시 해 보지 않고 끝낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const one = await connect('a');
    const two = await connect('a2');
    const got1 = record(one);
    await subscribe(one);
    await subscribe(two);
    table.set(JOB, appJob({ status: 'succeeded', progress: 100 }));
    let releaseTwo!: () => void;
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a2') {
        await blocked((release) => (releaseTwo = release));
        throw new Error('db down');
      }
      return { userId: 'a' };
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(releaseTwo).toBeTypeOf('function'));
    two.emit('ai:unsubscribe', { jobId: JOB });
    await settle();
    releaseTwo();
    await polling;
    await vi.waitFor(() => expect(got1.done).toHaveLength(1));
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('처리 중에 취소한 작업의 updatedAt만 바뀌어도(처리기가 잠금을 풂) 그 차례에 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    const canceled = appJob({ status: 'canceled', progress: 40 });
    table.set(JOB, canceled);
    const hold = holdNextVerify();
    const polling = gateway.poll();
    await vi.waitFor(() => expect(hold.release).toBeTypeOf('function'));
    const released = { ...canceled, updatedAt: '2026-11-16T00:00:03.000Z' };
    table.set(JOB, released);
    hold.release!();
    await polling;
    // 보내기 바로 전에 읽은 결과를 보낸다
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: released }]));
  });

  it('토큰이 거절(401)된 소켓만 있으면 다시 시도하지 않고 끝낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ status: 'succeeded', progress: 100 }));
    tokens.verifyAccess.mockRejectedValue(new UnauthorizedException());
    await gateway.poll();
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
    expect(got.done).toEqual([]);
  });

  it('결과 읽기가 계속 실패하면 5번째에 그만 지켜본다', async () => {
    const a = await connect('a');
    await subscribe(a);
    table.set(JOB, appJob({ status: 'succeeded', progress: 100 }));
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockRejectedValue(new Error('broken row'));
    for (let i = 0; i < 5; i++) await gateway.poll();
    jobs.findMine.mockImplementation(original);
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('구독을 확인하는 사이 소켓이 끊기면 방에 넣지 않는다', async () => {
    const a = await connect('a');
    let release!: () => void;
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockImplementationOnce(async (userId: string, jobId: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      return original(userId, jobId);
    });
    a.emit('ai:subscribe', { jobId: JOB });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    a.disconnect();
    await settle();
    release();
    await settle();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('끝난 작업을 결과 읽기 전에 지웠으면(404) 보내지 않고 더 지켜보지 않는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    jobs.progressOf.mockResolvedValueOnce([{ jobId: JOB, status: 'succeeded', progress: 100 }]);
    table.delete(JOB);
    await gateway.poll();
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
    expect(got.done).toEqual([]);
  });

  it('대문자 id로 구독해도 같은 작업으로 계속 받는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await expect(subscribe(a, JOB.toUpperCase())).resolves.toEqual({ ok: true });
    table.set(JOB, appJob({ progress: 45 }));
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)).toMatchObject({ jobId: JOB, progress: 45 }));
  });

  it('구독을 확인하는 중에 해지가 오면 해지가 나중에 적용된다', async () => {
    const a = await connect('a');
    const got = record(a);
    let release!: () => void;
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockImplementationOnce(async (userId: string, jobId: string) => {
      await new Promise<void>((resolve) => (release = resolve));
      return original(userId, jobId);
    });
    const pending = subscribe(a);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    a.emit('ai:unsubscribe', { jobId: JOB });
    await settle();
    release();
    await pending;
    await settle();
    table.set(JOB, appJob({ progress: 88 }));
    await gateway.poll();
    await settle();
    expect(got.progress.map((p) => p.progress)).not.toContain(88);
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('구독하면 1초 간격으로 스스로 다시 읽는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ progress: 33 }));
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(33), { timeout: 3000 });
  });
});

/**
 * API 서버가 여러 대일 때(App Service 스케일아웃). 앱의 소켓은 이 서버(gateway)에 붙어 있고, 다시 시도 요청(HTTP)은
 * 다른 서버가 받는다. 두 서버는 같은 DB(table)를 보지만 다시 시도 알림(AiJobsService.onRetry)은 그 요청을 받은 서버
 * 안에서만 불린다(#526 B11)
 */
describe('AI 작업 진행률 소켓 — 다시 시도를 다른 서버가 받을 때', () => {
  /** 다른 서버의 게이트웨이가 등록한 다시 시도 알림 */
  const otherListeners = new Set<(jobId: string) => void>();
  let other: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AiJobsGateway,
        {
          provide: AiJobsService,
          useValue: {
            onRetry: (listener: (jobId: string) => void) => {
              otherListeners.add(listener);
              return () => otherListeners.delete(listener);
            },
            findMine: async (userId: string, jobId: string) => {
              const job = table.get(jobId.toLowerCase());
              if (!job || userId !== 'a') throw new NotFoundException();
              return job;
            },
            progressOf: async () => [],
          },
        },
        { provide: TokenService, useValue: tokens },
      ],
    }).compile();
    other = module.createNestApplication();
    await other.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await other?.close();
  });

  /** 다른 서버의 AiJobsService.retry: 같은 DB의 작업을 새 실행으로 바꾸고 그 서버 안의 알림만 부른다 */
  const retryOnOtherServer = (job: AppAiJob) => {
    table.set(job._id, job);
    otherListeners.forEach((listener) => listener(job._id));
  };
  const queued = () =>
    appJob({
      status: 'queued',
      progress: 0,
      step: undefined,
      updatedAt: '2026-11-16T00:05:00.000Z',
    });
  const failed = () => appJob({ status: 'failed', progress: 30, error: 'AI_JOB_FAILED' });

  it('결과 읽기가 다시 시도를 쓰기 전에 나가 다시 구독을 마친 뒤에 돌아와도 앞 실행의 결과를 보내지 않고 새 구독을 지킨다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const a = await connect('a');
    // 같은 사용자의 다른 기기: 다시 시도하지 않아 다시 구독하지도 않는다
    const device = await connect('a2');
    const got = record(a);
    const gotDevice = record(device);
    await subscribe(a);
    await subscribe(device);
    table.set(JOB, failed());
    // done()의 결과 읽기: 다시 시도 전의 값(failed)을 읽은 채 응답만 늦게 온다
    let releaseRead!: () => void;
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockImplementationOnce(async (userId: string, jobId: string) => {
      const before = await original(userId, jobId);
      await blocked((release) => (releaseRead = release));
      return before;
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    // 다시 시도는 다른 서버가 받고, 응답을 받은 앱은 이 서버에 붙은 소켓으로 해지한 뒤 다시 구독한다
    retryOnOtherServer(queued());
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    releaseRead();
    await polling;
    await settle();
    // 앞 실행의 실패를 받으면 앱(ConvertScreen.finish)은 지금 실행이 실패한 것으로 보고 조회도 멈춘다
    expect(got.done).toEqual([]);
    expect(gotDevice.done).toEqual([]);
    // 두 소켓 모두 방에 남아 새 실행의 진행률 · 결과를 받는다
    table.set(JOB, appJob({ progress: 15, updatedAt: '2026-11-16T00:05:00.000Z' }));
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got.progress.at(-1)?.progress).toBe(15);
      expect(gotDevice.progress.at(-1)?.progress).toBe(15);
    });
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:06:00.000Z',
    });
    table.set(JOB, second);
    await gateway.poll();
    await vi.waitFor(() => {
      expect(got.done).toEqual([{ jobId: JOB, job: second }]);
      expect(gotDevice.done).toEqual([{ jobId: JOB, job: second }]);
    });
  });

  it('일시 오류가 쌓인 뒤 결과 읽기를 기다리는 사이 다시 시도 · 다시 구독되고 그 읽기가 실패해도 새 구독을 지킨다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, failed());
    // 결과 읽기가 4번 일시 오류(한도 5번의 바로 앞)
    for (let i = 0; i < 4; i++) {
      jobs.findMine.mockRejectedValueOnce(new Error('db down'));
      await gateway.poll();
    }
    // 다섯 번째 읽기: 기다리는 사이 다른 서버가 다시 시도 · 이 서버로 다시 구독, 그 뒤 일시 오류로 실패
    let releaseRead!: () => void;
    jobs.findMine.mockImplementationOnce(async () => {
      await blocked((release) => (releaseRead = release));
      throw new Error('db down');
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    retryOnOtherServer(queued());
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    releaseRead();
    await polling;
    // 앞 실행의 일시 오류로 그만 지켜보지 않는다(finish()가 새 구독까지 방에서 빼지 않음)
    table.set(JOB, appJob({ progress: 15, updatedAt: '2026-11-16T00:05:00.000Z' }));
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(15));
    expect(got.done).toEqual([]);
  });

  it('다시 구독한 소켓: 앞 실행에서 쌓인 일시 오류 수는 처음부터 센다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, failed());
    for (let i = 0; i < 4; i++) {
      jobs.findMine.mockRejectedValueOnce(new Error('db down'));
      await gateway.poll();
    }
    retryOnOtherServer(queued());
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    // 새 실행이 끝났는데 결과 읽기가 한 번 일시 오류 → 그만 지켜보지 않고 다음 차례에 보낸다
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:06:00.000Z',
    });
    table.set(JOB, second);
    jobs.findMine.mockRejectedValueOnce(new Error('db down'));
    await gateway.poll();
    await settle();
    expect(got.done).toEqual([]);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: second }]));
  });

  it('다시 구독하기 전에 새 실행이 끝나도, 늦게 돌아온 앞 실행의 결과를 다시 구독하지 않은 기기에 보내지 않고 새 결과를 보낸다', async () => {
    tokens.verifyAccess.mockImplementation(async () => ({ userId: 'a' }));
    const a = await connect('a');
    const device = await connect('a2');
    const got = record(a);
    const gotDevice = record(device);
    await subscribe(a);
    await subscribe(device);
    table.set(JOB, failed());
    // done()의 결과 읽기: 다시 시도 전의 값(failed)을 읽은 채 응답만 늦게 온다
    let releaseRead!: () => void;
    const original = jobs.findMine.getMockImplementation()!;
    jobs.findMine.mockImplementationOnce(async (userId: string, jobId: string) => {
      const before = await original(userId, jobId);
      await blocked((release) => (releaseRead = release));
      return before;
    });
    const polling = gateway.poll();
    await vi.waitFor(() => expect(releaseRead).toBeTypeOf('function'));
    // 다른 서버가 다시 시도하고, 앱이 다시 구독하기 전에 처리기가 새 실행을 끝낸다
    retryOnOtherServer(queued());
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:06:00.000Z',
    });
    table.set(JOB, second);
    // 다시 구독은 끝난 새 실행을 읽어 바로 받는다(방에는 들어가지 않음)
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: second }]));
    releaseRead();
    await polling;
    await settle();
    // 다시 구독하지 않은 기기는 앞 실행의 실패를 받지 않고 방에 남는다
    expect(gotDevice.done).toEqual([]);
    await gateway.poll();
    await vi.waitFor(() => expect(gotDevice.done).toEqual([{ jobId: JOB, job: second }]));
    await settle();
    expect(got.done).toHaveLength(1);
    // 모두 받은 뒤에는 더 지켜보지 않는다
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('서버마다 시계가 달라 새 실행이 끝난 시각(처리기)이 다시 시도 시각(API)보다 앞서도 새 결과를 보낸다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, failed());
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toHaveLength(1));
    // 다시 시도는 다른 서버(시계가 빠름)가 00:05로 쓰고, 앱은 이 서버로 다시 구독한다
    retryOnOtherServer(queued());
    a.emit('ai:unsubscribe', { jobId: JOB });
    await expect(subscribe(a)).resolves.toEqual({ ok: true });
    // 처리기(시계가 느림)가 곧바로 실패로 끝내며 00:04로 쓴다
    const second = appJob({
      status: 'failed',
      progress: 0,
      error: 'INVALID_FILE',
      updatedAt: '2026-11-16T00:04:00.000Z',
    });
    table.set(JOB, second);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done.at(-1)).toEqual({ jobId: JOB, job: second }));
    expect(got.done).toHaveLength(2);
    // 보낸 뒤에는 더 지켜보지 않는다(끝없이 다시 읽지 않음)
    jobs.progressOf.mockClear();
    await gateway.poll();
    expect(jobs.progressOf).not.toHaveBeenCalled();
  });

  it('다시 구독하지 않은 기기만 지켜봐도, 새 실행을 읽으면 앞 실행에서 쌓인 일시 오류 수를 처음부터 센다', async () => {
    const device = await connect('a');
    const got = record(device);
    await subscribe(device);
    table.set(JOB, failed());
    for (let i = 0; i < 4; i++) {
      jobs.findMine.mockRejectedValueOnce(new Error('db down'));
      await gateway.poll();
    }
    // 다시 시도는 다른 기기 · 다른 서버에서. 이 서버는 반복 읽기로만 새 실행을 본다
    retryOnOtherServer(queued());
    await gateway.poll();
    await vi.waitFor(() => expect(got.progress.at(-1)?.status).toBe('queued'));
    const second = appJob({
      status: 'succeeded',
      progress: 100,
      updatedAt: '2026-11-16T00:06:00.000Z',
    });
    table.set(JOB, second);
    jobs.findMine.mockRejectedValueOnce(new Error('db down'));
    await gateway.poll();
    await settle();
    expect(got.done).toEqual([]);
    await gateway.poll();
    await vi.waitFor(() => expect(got.done).toEqual([{ jobId: JOB, job: second }]));
  });
});
