import { AiJob } from '@notelink/shared';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  AI_JOB_FAILED,
  AiJobsService,
  toAppError,
  toAppJob,
} from '../src/ai-jobs/ai-jobs.service.js';
import { AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { createFakeJobs, LATER, PAST } from './support/fake-ai-jobs.js';

const ME = new Types.ObjectId().toString();
const OTHER = new Types.ObjectId().toString();
const NOTE = new Types.ObjectId().toString();
const SET = new Types.ObjectId().toString();

function setup() {
  const fake = createFakeJobs();
  const service = new AiJobsService(fake.model);
  const add = (over: Partial<Parameters<typeof service.enqueue>[0]> = {}) =>
    service.enqueue({
      type: 'quiz_generate',
      userId: ME,
      targetType: 'quiz_set',
      targetId: SET,
      input: { material: { pages: [] } },
      ...over,
    });
  const row = (id: string) => fake.rows.find((r) => r._id.toString() === id)!;
  return { ...fake, service, add, row };
}

const notFound = { response: { code: 'NOT_FOUND' }, status: 404 };

describe('AiJobsService.enqueue', () => {
  it('처리기가 가져갈 수 있는 처음 값으로 넣는다(apps/ai jobs.py 「NestJS가 넣음」)', async () => {
    const { add, rows } = setup();
    const job = await add();
    expect(rows[0]).toMatchObject({
      status: 'queued',
      progress: 0,
      attempts: 0,
      result: null,
      awaited: false,
      input: { material: { pages: [] } },
    });
    expect(rows[0]!['userId']).toBeInstanceOf(Types.ObjectId);
    expect(rows[0]!['targetId']).toBeInstanceOf(Types.ObjectId);
    expect(job).toMatchObject({ status: 'queued', targetType: 'quiz_set', targetId: SET });
  });

  it('앱에 보내는 모양은 공용 스키마 AiJob과 같고 input · userId는 빼고 보낸다', async () => {
    const job = await setup().add();
    expect(AiJob.parse(job)).toEqual(job);
    expect(job).not.toHaveProperty('input');
    expect(job).not.toHaveProperty('userId');
  });

  it('서버 안에서 넘긴 id가 틀리면 404가 아니라 서버 오류로 올린다', async () => {
    const failed = setup().add({ targetId: '' });
    await expect(failed).rejects.toThrow('ai_jobs: targetId');
    await expect(failed).rejects.not.toHaveProperty('status');
  });

  it('result의 기본값은 공용 계약처럼 null', () => {
    expect(AiJobSchema.path('result').options.default).toBeNull();
  });
});

describe('AiJobsService.findMine', () => {
  it('내 작업은 처리기가 쓴 진행률 · 단계를 그대로 보여 준다', async () => {
    const { service, add, row } = setup();
    const { _id } = await add();
    Object.assign(row(_id), {
      status: 'running',
      progress: 40,
      step: '문제 만들기',
      lockedBy: 'w0',
    });
    const job = await service.findMine(ME, _id);
    expect(job).toMatchObject({ status: 'running', progress: 40, step: '문제 만들기' });
    expect(job).not.toHaveProperty('lockedBy');
    expect(AiJob.parse(job)).toEqual(job);
  });

  it('남의 작업 · 없는 작업 · 형식이 틀린 id는 모두 404', async () => {
    const { service, add } = setup();
    const { _id } = await add();
    await expect(service.findMine(OTHER, _id)).rejects.toMatchObject(notFound);
    await expect(service.findMine(ME, new Types.ObjectId().toString())).rejects.toMatchObject(
      notFound,
    );
    await expect(service.findMine(ME, 'not-an-id')).rejects.toMatchObject(notFound);
    // 12글자 문자열도 ObjectId로 읽힐 수 있어 따로 막는다
    await expect(service.findMine(ME, 'abcdefghijkl')).rejects.toMatchObject(notFound);
  });
});

describe('AiJobsService.cancel', () => {
  it.each(['queued', 'running'])('%s 작업은 canceled로', async (status) => {
    const { service, add, row } = setup();
    const { _id } = await add();
    row(_id)['status'] = status;
    await service.cancel(ME, _id);
    expect(row(_id)['status']).toBe('canceled');
  });

  it.each(['succeeded', 'failed'])('이미 끝난(%s) 작업은 그대로 둔다', async (status) => {
    const { service, add, row } = setup();
    const { _id } = await add();
    row(_id)['status'] = status;
    await service.cancel(ME, _id);
    expect(row(_id)['status']).toBe(status);
  });

  it('미리 만들기는 몇 번 취소해도 지우지 않고 이어받기만 푼다', async () => {
    const { service, add, row } = setup();
    const { _id } = await add({ type: 'quiz_pregen', targetType: 'material', targetId: NOTE });
    row(_id)['awaited'] = true;
    await service.cancel(ME, _id);
    await service.cancel(ME, _id);
    expect(row(_id)).toMatchObject({ status: 'queued', awaited: false });
    // 두 요청이 겹쳐도 같다(가짜 DB라 실제 MongoDB의 경쟁까지는 보지 않는다. 두 단계 모두 조건부 갱신)
    row(_id)['awaited'] = true;
    await Promise.all([service.cancel(ME, _id), service.cancel(ME, _id)]);
    expect(row(_id)).toMatchObject({ status: 'queued', awaited: false });
  });

  it('남의 작업은 바꾸지 않고 404', async () => {
    const { service, add, row } = setup();
    const { _id } = await add();
    await expect(service.cancel(OTHER, _id)).rejects.toMatchObject(notFound);
    expect(row(_id)['status']).toBe('queued');
  });
});

describe('AiJobsService.retry', () => {
  it.each(['failed', 'canceled'])(
    '%s 작업은 처리기 규칙대로 되돌려 다시 넣는다',
    async (status) => {
      const { service, add, row } = setup();
      const { _id } = await add();
      Object.assign(row(_id), {
        status,
        attempts: 3,
        progress: 60,
        step: '검수',
        error: 'TimeoutError: 시간 초과',
        retryAt: new Date(),
        lockedBy: 'w0',
        lockedUntil: PAST,
        checkpoint: { slots: [1] },
      });
      const job = await service.retry(ME, _id);
      expect(row(_id)).toMatchObject({
        status: 'queued',
        attempts: 0,
        progress: 0,
        retryAt: null,
        lockedUntil: null,
        error: null,
        result: null,
        checkpoint: { slots: [1] }, // 처리기가 다시 쓸 중간 결과는 남긴다
      });
      expect(row(_id)).not.toHaveProperty('step');
      expect(row(_id)).not.toHaveProperty('lockedBy');
      expect(job).toMatchObject({ status: 'queued', attempts: 0, error: null });
      expect(AiJob.parse(job)).toEqual(job);
    },
  );

  it.each(['queued', 'running', 'succeeded'])(
    '%s 작업은 바꾸지 않고 지금 상태를 돌려준다',
    async (status) => {
      const { service, add, row } = setup();
      const { _id } = await add();
      Object.assign(row(_id), { status, attempts: 1 });
      const job = await service.retry(ME, _id);
      expect(job).toMatchObject({ status, attempts: 1 });
    },
  );

  it('처리 중에 취소해 처리기가 아직 잡고 있으면 다시 넣지 않는다(같은 작업을 두 번 만들지 않게)', async () => {
    const { service, add, row } = setup();
    const { _id } = await add();
    Object.assign(row(_id), { status: 'canceled', lockedBy: 'w0', lockedUntil: LATER });
    const job = await service.retry(ME, _id);
    expect(job.status).toBe('canceled');
    expect(row(_id)).toMatchObject({ status: 'canceled', lockedBy: 'w0' });
    // 잠금이 풀리면 다시 넣는다
    row(_id)['lockedUntil'] = PAST;
    expect((await service.retry(ME, _id)).status).toBe('queued');
  });

  it('남의 작업은 404', async () => {
    const { service, add, row } = setup();
    const { _id } = await add();
    row(_id)['status'] = 'failed';
    await expect(service.retry(OTHER, _id)).rejects.toMatchObject(notFound);
    expect(row(_id)['status']).toBe('failed');
  });
});

describe('AiJobsService.takeOverPregen', () => {
  const pregen = { type: 'quiz_pregen', targetType: 'material', targetId: NOTE };

  it.each([
    ['queued', null],
    ['running', LATER],
  ])('끝나지 않은(%s) 미리 만들기는 awaited로 이어받는다', async (status, lockedUntil) => {
    const { service, add, row } = setup();
    const { _id } = await add(pregen);
    Object.assign(row(_id), { status, lockedUntil });
    const job = await service.takeOverPregen(ME, 'material', NOTE);
    expect(job).toMatchObject({ _id, awaited: true });
    expect(row(_id)['awaited']).toBe(true);
  });

  it('같은 노트에 둘이면 가장 나중 것을 이어받는다', async () => {
    const { service, add, row } = setup();
    const old = await add(pregen);
    const latest = await add(pregen);
    const job = await service.takeOverPregen(ME, 'material', NOTE);
    expect(job?._id).toBe(latest._id);
    expect(row(old._id)['awaited']).toBe(false);
  });

  it('끝난 미리 만들기 · 다른 노트 · 남의 노트 · 다른 종류는 이어받지 않는다', async () => {
    const { service, add, row } = setup();
    const done = await add(pregen);
    row(done._id)['status'] = 'failed';
    await add({ ...pregen, targetId: new Types.ObjectId().toString() });
    await add({ ...pregen, userId: OTHER });
    await add({ type: 'quiz_generate', targetType: 'material', targetId: NOTE });
    expect(await service.takeOverPregen(ME, 'material', NOTE)).toBeNull();
  });

  it.each([0, 2, 3, 5])(
    '잠금이 지난 running(처리기 멈춤)도 시도 횟수(%i)와 상관없이 이어받고 처리기 상태는 그대로 둔다',
    async (attempts) => {
      // 처리기가 다시 가져가면 새로 넣은 작업과 둘 다 처리된다(Codex #188). 시도 한도는 처리기 설정이라 보지 않는다
      const { service, add, row } = setup();
      const { _id } = await add(pregen);
      Object.assign(row(_id), { status: 'running', attempts, lockedBy: 'w1', lockedUntil: PAST });
      expect(await service.takeOverPregen(ME, 'material', NOTE)).toMatchObject({
        _id,
        awaited: true,
      });
      expect(row(_id)).toMatchObject({ status: 'running', attempts, lockedBy: 'w1' });
    },
  );

  it('이어받은 작업이 시도 한도로 failed가 되면 다시 시도로 awaited 그대로 다시 넣는다', async () => {
    const { service, add, row } = setup();
    const { _id } = await add(pregen);
    Object.assign(row(_id), { status: 'running', attempts: 3, lockedUntil: PAST });
    await service.takeOverPregen(ME, 'material', NOTE);
    // 처리기 _give_up_stalled가 쓰는 모양(apps/ai jobs.py)
    Object.assign(row(_id), {
      status: 'failed',
      error: '처리가 끝나지 않음(시도 한도)',
      lockedBy: null,
      lockedUntil: null,
    });
    expect(await service.retry(ME, _id)).toMatchObject({
      _id,
      status: 'queued',
      attempts: 0,
      error: null,
      awaited: true,
    });
  });
});

describe('toAppJob', () => {
  it('처리기가 지운 step · null 값은 공용 스키마에 맞게 보낸다', () => {
    const at = new Date('2026-11-07T00:00:00Z');
    const job = toAppJob({
      _id: new Types.ObjectId(),
      type: 'recording_summary',
      status: 'failed',
      targetType: 'material',
      targetId: new Types.ObjectId(),
      step: null,
      createdAt: at,
      updatedAt: at,
    });
    expect(job).not.toHaveProperty('step');
    expect(job).toMatchObject({ progress: 0, attempts: 0, result: null, error: null });
    expect(AiJob.parse(job)).toEqual(job);
  });
});

describe('toAppError', () => {
  it.each([
    // apps/ai runner.py가 쓰는 문구들
    ['AI 응답을 받지 못함(Connection refused: http://10.0.0.5:8000/v1)', AI_JOB_FAILED],
    ['처리 중 오류', AI_JOB_FAILED],
    ['처리가 끝나지 않음(시도 한도)', AI_JOB_FAILED],
    ['입력 오류: input이 객체가 아님', AI_JOB_FAILED],
    ['NO_SPEECH: 말소리를 찾지 못함', 'NO_SPEECH'],
    ['INVALID_FILE: 녹음이 3분보다 짧음', 'INVALID_FILE'],
    ['NO_QUESTIONS: 만든 문제가 없음(검사 탈락(검수자 답 E))', 'NO_QUESTIONS'],
    // 앱이 모르는 코드 모양 문구(예외 이름 등)는 내보내지 않는다
    ['HTTP: 502 Bad Gateway', AI_JOB_FAILED],
    ['', AI_JOB_FAILED],
  ])('%j → %s (처리기 문구는 앱에 보내지 않는다)', (error, code) => {
    expect(toAppError(error)).toBe(code);
  });

  it('오류가 없으면 null', () => {
    expect(toAppError(null)).toBeNull();
    expect(toAppError(undefined)).toBeNull();
  });

  it('조회 응답에도 코드만 담긴다', async () => {
    const { service, add, row } = setup();
    const { _id } = await add();
    Object.assign(row(_id), { status: 'failed', error: 'AI 응답을 받지 못함(timeout)' });
    expect((await service.findMine(ME, _id)).error).toBe(AI_JOB_FAILED);
    expect(row(_id)['error']).toBe('AI 응답을 받지 못함(timeout)');
  });

  it('조회 · 다시 시도 · 이어받기는 앱에 보내지 않는 input · checkpoint를 DB에서 읽지 않는다', async () => {
    const { service, add, model } = setup();
    const { _id } = await add({ type: 'quiz_pregen', targetType: 'material', targetId: NOTE });
    const findOne = vi.spyOn(model, 'findOne');
    const update = vi.spyOn(model, 'findOneAndUpdate');
    await service.findMine(ME, _id);
    await service.retry(ME, _id);
    await service.takeOverPregen(ME, 'material', NOTE);
    const hidden = { input: 0, checkpoint: 0 };
    // findMine 두 번(직접 · retry가 다시 넣지 않아 지금 상태를 읽음) + retry가 종류만 읽기 한 번,
    // retry · takeOverPregen 변경 한 번씩
    expect(findOne).toHaveBeenCalledTimes(3);
    for (const call of findOne.mock.calls) expect([hidden, { type: 1 }]).toContainEqual(call[1]);
    expect(update).toHaveBeenCalledTimes(2);
    for (const call of update.mock.calls) {
      expect((call[2] as { projection?: unknown }).projection).toEqual(hidden);
    }
  });
});

describe('한도 확인 중(held) 작업 (Codex #244 · #249)', () => {
  const ask = { type: 'note_ask', targetType: 'material', targetId: NOTE } as const;
  const stale = () => new Date(Date.now() - 120_000);

  it('확인 도중 멈춰 지난 held는 취소할 수 있고, 다시 시도로도 되살린다', async () => {
    const { service, add, row } = setup();
    const a = await add(ask);
    Object.assign(row(a._id), { status: 'held', heldAt: stale() });
    await service.cancel(ME, a._id);
    expect(row(a._id)).toMatchObject({ status: 'canceled' });

    const b = await add(ask);
    Object.assign(row(b._id), { status: 'held', heldAt: stale() });
    expect(await service.retry(ME, b._id)).toMatchObject({ status: 'queued' });
    expect(row(b._id)).toMatchObject({ status: 'queued' });
    expect(row(b._id)).not.toHaveProperty('heldAt');
  });

  it('한도 없는 종류의 다시 시도는 held를 거치지 않는다(멈춰도 남지 않게)', async () => {
    const { service, add, row, model } = setup();
    const { _id } = await add();
    Object.assign(row(_id), { status: 'failed' });
    const update = vi.spyOn(model, 'findOneAndUpdate');
    await service.retry(ME, _id);
    for (const call of update.mock.calls) {
      expect((call[1] as { $set?: { status?: string } }).$set?.status).not.toBe('held');
    }
    expect(row(_id)).toMatchObject({ status: 'queued' });
  });

  it('다시 시도의 한도 확인 중에 취소하면 확인이 끝나도 취소 그대로다', async () => {
    const { service, add, row, model } = setup();
    const { _id } = await add(ask);
    Object.assign(row(_id), { status: 'canceled' });
    const count = model.countDocuments.bind(model);
    vi.spyOn(model, 'countDocuments').mockImplementationOnce((async (f: never) => {
      await service.cancel(ME, _id);
      return count(f);
    }) as never);
    expect(await service.retry(ME, _id)).toMatchObject({ status: 'canceled' });
    expect(row(_id)).toMatchObject({ status: 'canceled' });
  });

  it('확인이 늦어 지난 사이 다른 다시 시도가 같은 작업을 새로 잡으면, 늦은 요청은 그 held를 열지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { service, add, row, model } = setup();
      const x = await add(ask);
      Object.assign(row(x._id), { status: 'failed' });
      const count = model.countDocuments.bind(model);
      let otherHold: Date | undefined;
      // 요청 A가 세는 동안 61초가 지나고, 다른 작업 둘이 한도를 채운 뒤 요청 B가 X를 새로 잡는다
      vi.spyOn(model, 'countDocuments').mockImplementationOnce((async (f: never) => {
        const n = await count(f);
        vi.setSystemTime(Date.now() + 61_000);
        for (let i = 0; i < 2; i++) Object.assign(row((await add(ask))._id), { status: 'queued' });
        otherHold = new Date();
        Object.assign(row(x._id), { status: 'held', heldAt: otherHold });
        return n;
      }) as never);
      await service.retry(ME, x._id);
      // B의 확인은 그대로 남아 B가 한도를 넘겼다고 보고 되돌릴 수 있다(A가 대신 열어 3개가 되지 않음)
      expect(row(x._id)).toMatchObject({ status: 'held', heldAt: otherHold });
    } finally {
      vi.useRealTimers();
    }
  });

  it('확인이 늦어 held가 지나면(다른 요청의 한도 계산에서 빠짐) 열지 않고 429', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { service, rows, model } = setup();
      const count = model.countDocuments.bind(model);
      // 넣은 뒤 세는 동안 61초가 지난다
      vi.spyOn(model, 'countDocuments')
        .mockImplementationOnce(count as never)
        .mockImplementationOnce((async (f: never) => {
          const n = await count(f);
          vi.setSystemTime(Date.now() + 61_000);
          return n;
        }) as never);
      await expect(service.enqueue({ ...ask, userId: ME, input: {} })).rejects.toMatchObject({
        status: 429,
      });
      expect(rows).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
