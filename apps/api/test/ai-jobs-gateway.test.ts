import { type INestApplication, NotFoundException } from '@nestjs/common';
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
const jobs = {
  findMine: vi.fn(async (userId: string, jobId: string) => {
    const job = table.get(jobId);
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
  vi.clearAllMocks();
  table.clear();
  table.set(JOB, appJob());
  tokens.verifyAccess.mockImplementation(async (token: string) => {
    if (token === 'bad') throw new Error('unauthorized');
    return { userId: token };
  });
});
afterEach(async () => {
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
    tokens.verifyAccess.mockRejectedValue(new Error('expired'));
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

  it('구독하면 1초 간격으로 스스로 다시 읽는다', async () => {
    const a = await connect('a');
    const got = record(a);
    await subscribe(a);
    table.set(JOB, appJob({ progress: 33 }));
    await vi.waitFor(() => expect(got.progress.at(-1)?.progress).toBe(33), { timeout: 3000 });
  });
});
