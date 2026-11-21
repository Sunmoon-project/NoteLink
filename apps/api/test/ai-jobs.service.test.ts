import { AiJob } from '@notelink/shared';
import { model, Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  AI_JOB_FAILED,
  AiJobsService,
  toAppError,
  toAppJob,
} from '../src/ai-jobs/ai-jobs.service.js';
import { AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { createFakeJobs, LATER, PAST } from './support/fake-ai-jobs.js';
import { setDbClockOffset } from './support/fake-collection.js';

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

  it('퀴즈 작업 입력의 빈 노트 이력을 저장할 때 보존한다', () => {
    const JobModel = model('AiJobEmptyInputTest', AiJobSchema);
    const row = new JobModel({ input: { notes: {} } }).toObject();
    expect(row.input).toEqual({ notes: {} });
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

describe('AiJobsService.progressOf (소켓 진행률)', () => {
  it('여러 작업의 상태 · 진행률 · 단계만 돌려주고, held는 queued로 보낸다', async () => {
    const { service, add, row } = setup();
    const a = await add();
    const b = await add();
    Object.assign(row(a._id), { status: 'running', progress: 40, step: '문제 만들기' });
    Object.assign(row(b._id), { status: 'held', step: null, result: { big: true } });
    const list = await service.progressOf([a._id, b._id]);
    expect(list).toEqual(
      expect.arrayContaining([
        { jobId: a._id, status: 'running', progress: 40, step: '문제 만들기' },
        { jobId: b._id, status: 'queued', progress: 0 },
      ]),
    );
    expect(list).toHaveLength(2);
  });

  it('형식이 틀린 id · 없는 작업은 빼고, 남은 게 없으면 DB를 읽지 않는다', async () => {
    const { service, add, model } = setup();
    const { _id } = await add();
    const find = vi.spyOn(model, 'find');
    await expect(
      service.progressOf([_id, 'not-an-id', new Types.ObjectId().toString()]),
    ).resolves.toEqual([{ jobId: _id, status: 'queued', progress: 0 }]);
    find.mockClear();
    await expect(service.progressOf(['abcdefghijkl'])).resolves.toEqual([]);
    expect(find).not.toHaveBeenCalled();
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

describe('AiJobsService.cancelByUser (앱의 취소, #626)', () => {
  /** 받은 cancel()을 부르고 그 결과(취소로 멈춘 상태인지)를 남기는 등록 함수 */
  const withHandler = () => {
    const t = setup();
    const stopped: boolean[] = [];
    const handler = vi.fn(async (ctx: { cancel: () => Promise<boolean> }) => {
      stopped.push(await ctx.cancel());
    });
    t.service.registerCancelHandler('quiz_generate', handler);
    t.service.registerCancelHandler('quiz_pregen', handler);
    return { ...t, handler, stopped };
  };

  it.each(['queued', 'running'])(
    '%s 작업은 등록한 함수가 멈추고, 취소로 멈춘 상태(true)를 받는다',
    async (status) => {
      const { service, add, row, handler, stopped } = withHandler();
      const { _id } = await add();
      row(_id)['status'] = status;
      await service.cancelByUser(ME, _id);
      expect(row(_id)['status']).toBe('canceled');
      expect(handler).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ userId: ME, jobId: _id }),
      );
      expect(stopped).toEqual([true]);
    },
  );

  it.each(['succeeded', 'failed'])(
    '취소가 닿기 전에 끝난(%s) 작업은 그대로이고 false를 받는다(늦은 취소)',
    async (status) => {
      const { service, add, row, stopped } = withHandler();
      const { _id } = await add();
      row(_id)['status'] = status;
      await service.cancelByUser(ME, _id);
      expect(row(_id)['status']).toBe(status);
      expect(stopped).toEqual([false]);
    },
  );

  it('미리 만들기는 이어받기를 풀고 도는 동안 true, 다 끝났으면 false', async () => {
    const { service, add, row, stopped } = withHandler();
    const { _id } = await add({ type: 'quiz_pregen', targetType: 'material', targetId: NOTE });
    row(_id)['awaited'] = true;
    await service.cancelByUser(ME, _id);
    expect(row(_id)).toMatchObject({ status: 'queued', awaited: false });
    await service.cancelByUser(ME, _id); // 두 번 눌러도 같다(앞 정리가 실패했어도 마저 하게)
    row(_id)['status'] = 'succeeded';
    await service.cancelByUser(ME, _id);
    expect(stopped).toEqual([true, true, false]);
  });

  it('이어받기를 푼 바로 뒤에 미리 만들기가 끝나도 true(바꾼 결과로 정함, Codex 2차)', async () => {
    const { service, add, row, rows, model, stopped } = withHandler();
    const { _id } = await add({ type: 'quiz_pregen', targetType: 'material', targetId: NOTE });
    row(_id)['awaited'] = true;
    const update = model.findOneAndUpdate.bind(model);
    vi.spyOn(model, 'findOneAndUpdate').mockImplementation(((
      ...args: Parameters<typeof update>
    ) => {
      const q = update(...args);
      // 이어받기를 풀자마자 처리기가 끝냄
      if ((args[1] as { $set?: { awaited?: boolean } }).$set?.awaited === false)
        Object.assign(
          rows.find((r) => String(r._id) === _id)!,
          { status: 'succeeded' },
        );
      return q;
    }) as never);
    await service.cancelByUser(ME, _id);
    expect(row(_id)['status']).toBe('succeeded');
    expect(stopped).toEqual([true]);
  });

  it('canceled 작업을 또 취소해도 true(앞 정리가 실패했어도 다시 눌러 마저 하게)', async () => {
    const { service, add, stopped } = withHandler();
    const { _id } = await add();
    await service.cancelByUser(ME, _id);
    await service.cancelByUser(ME, _id);
    expect(stopped).toEqual([true, true]);
  });

  it('등록하지 않은 종류는 취소만 한다', async () => {
    const { service, add, row, handler } = withHandler();
    const { _id } = await add({ type: 'similar_quiz' });
    await service.cancelByUser(ME, _id);
    expect(row(_id)['status']).toBe('canceled');
    expect(handler).not.toHaveBeenCalled();
  });

  it('남의 작업 · 없는 작업은 404이고 부르지 않는다', async () => {
    const { service, add, row, handler } = withHandler();
    const { _id } = await add();
    await expect(service.cancelByUser(OTHER, _id)).rejects.toMatchObject(notFound);
    await expect(
      service.cancelByUser(ME, new Types.ObjectId().toHexString()),
    ).rejects.toMatchObject(notFound);
    expect(row(_id)['status']).toBe('queued');
    expect(handler).not.toHaveBeenCalled();
  });

  it('서버 안의 취소(cancel)는 부르지 않는다', async () => {
    const { service, add, handler } = withHandler();
    const { _id } = await add();
    await service.cancel(ME, _id);
    expect(handler).not.toHaveBeenCalled();
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

  it('다시 넣으면 응답하기 전에 onRetry로 알리고, 바꾸지 않았으면 알리지 않는다(진행률 소켓 #523)', async () => {
    const { service, add, row } = setup();
    const { _id } = await add();
    const listener = vi.fn((jobId: string) => {
      // 알릴 때는 이미 다시 넣은 뒤다
      expect(row(jobId)['status']).toBe('queued');
    });
    const off = service.onRetry(listener);
    // 처리 중이면 바꾸지 않으므로 알리지 않는다
    row(_id)['status'] = 'running';
    await service.retry(ME, _id);
    expect(listener).not.toHaveBeenCalled();
    row(_id)['status'] = 'failed';
    await service.retry(ME, _id);
    expect(listener).toHaveBeenCalledExactlyOnceWith(_id);
    // 등록을 풀면 더 알리지 않는다
    off();
    row(_id)['status'] = 'failed';
    await service.retry(ME, _id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('알림을 받는 쪽이 던져도 다시 시도는 그대로 응답한다', async () => {
    const { service, add, row } = setup();
    const { _id } = await add();
    service.onRetry(() => {
      throw new Error('gateway broken');
    });
    row(_id)['status'] = 'failed';
    await expect(service.retry(ME, _id)).resolves.toMatchObject({ status: 'queued' });
  });

  it('한도 있는 종류는 확인 중(held)으로 바꾼 때 알린다', async () => {
    const { service, add, row } = setup();
    const { _id } = await add({ type: 'note_ask', targetType: 'material', targetId: NOTE });
    const listener = vi.fn();
    service.onRetry(listener);
    row(_id)['status'] = 'failed';
    await service.retry(ME, _id);
    expect(listener).toHaveBeenCalledExactlyOnceWith(_id);
  });
});

describe('AiJobsService.retry 입력 새로 고치기', () => {
  const TYPE = 'handwriting_summary';
  const failedJob = async (
    ctx: ReturnType<typeof setup>,
    over: Partial<Parameters<ReturnType<typeof setup>['add']>[0]> = {},
  ) => {
    const { _id } = await ctx.add({
      type: TYPE,
      targetType: 'material',
      targetId: NOTE,
      input: { pages: [{ pageNo: 1, imageUrl: 'old' }], subject: '수학' },
      ...over,
    });
    Object.assign(ctx.row(_id), { status: 'failed', error: 'x', lockedUntil: PAST });
    return _id;
  };

  it('등록된 종류는 다시 시도할 때 새 input을 만들어 저장한다(그 밖의 값은 처리기 규칙대로)', async () => {
    const ctx = setup();
    const refresh = vi.fn(() =>
      Promise.resolve({ pages: [{ pageNo: 1, imageUrl: 'new' }], subject: '수학' }),
    );
    ctx.service.registerInputRefresher(TYPE, refresh);
    const _id = await failedJob(ctx);
    Object.assign(ctx.row(_id), { checkpoint: { done: 1 } });
    const job = await ctx.service.retry(ME, _id);
    expect(refresh).toHaveBeenCalledWith({
      userId: ME,
      targetType: 'material',
      targetId: NOTE,
      input: { pages: [{ pageNo: 1, imageUrl: 'old' }], subject: '수학' },
    });
    expect(ctx.row(_id)).toMatchObject({
      status: 'queued',
      input: { pages: [{ pageNo: 1, imageUrl: 'new' }], subject: '수학' },
      checkpoint: { done: 1 },
    });
    expect(job).not.toHaveProperty('input');
  });

  it('등록되지 않은 종류는 input을 그대로 두고 input을 읽지도 않는다', async () => {
    const ctx = setup();
    ctx.service.registerInputRefresher(TYPE, () => Promise.reject(new Error('부르면 안 됨')));
    const _id = await failedJob(ctx, { type: 'quiz_generate', targetType: 'quiz_set' });
    const findOne = vi.spyOn(ctx.model, 'findOne');
    await ctx.service.retry(ME, _id);
    expect(ctx.row(_id)).toMatchObject({ status: 'queued', input: { subject: '수학' } });
    for (const call of findOne.mock.calls) expect(call[1]).not.toHaveProperty('input', 1);
  });

  it('새로 고치기가 실패하면 오류를 올리고 작업은 바뀌지 않는다', async () => {
    const ctx = setup();
    ctx.service.registerInputRefresher(TYPE, () => Promise.reject(new Error('노트가 없어요')));
    const _id = await failedJob(ctx);
    const before = { ...ctx.row(_id) };
    await expect(ctx.service.retry(ME, _id)).rejects.toThrow('노트가 없어요');
    expect(ctx.row(_id)).toEqual(before);
  });

  it.each(['queued', 'running', 'succeeded'])(
    '%s 작업은 새로 고치지 않고 지금 상태를 돌려준다',
    async (status) => {
      const ctx = setup();
      const refresh = vi.fn(() => Promise.reject(new Error('부르면 안 됨')));
      ctx.service.registerInputRefresher(TYPE, refresh);
      const _id = await failedJob(ctx);
      Object.assign(ctx.row(_id), { status });
      expect((await ctx.service.retry(ME, _id)).status).toBe(status);
      expect(refresh).not.toHaveBeenCalled();
    },
  );
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
    // 노트가 50쪽을 넘음: 앱이 「50쪽 이하로 나눠 올려 주세요」로 알린다
    ['TOO_MANY_PAGES: 노트가 50쪽을 넘음(60쪽 이상)', 'TOO_MANY_PAGES'],
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
    const kind = { type: 1, status: 1, targetType: 1, targetId: 1 };
    for (const call of findOne.mock.calls) expect([hidden, kind]).toContainEqual(call[1]);
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
        Object.assign(row(x._id), { status: 'held', heldAt: otherHold, holdId: 'B' });
        return n;
      }) as never);
      await service.retry(ME, x._id);
      // B의 확인은 그대로 남아 B가 한도를 넘겼다고 보고 되돌릴 수 있다(A가 대신 열어 3개가 되지 않음)
      expect(row(x._id)).toMatchObject({ status: 'held', heldAt: otherHold, holdId: 'B' });
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
  const queued = (rows: Record<string, unknown>[]) =>
    rows.filter((r) => r.type === 'note_ask' && r.status === 'queued').length;

  it('같은 밀리초에 다른 요청이 같은 작업을 새로 잡아도, 늦은 요청은 그 held를 열지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { service, add, row, rows, model } = setup();
      const x = await add(ask);
      Object.assign(row(x._id), { status: 'failed' });
      const count = model.countDocuments.bind(model);
      // 시계가 멈춘 채(같은 밀리초): A가 세는 동안 취소 → 다른 작업 둘 → B가 X를 다시 잡는다
      vi.spyOn(model, 'countDocuments').mockImplementationOnce((async (f: never) => {
        const n = await count(f);
        await service.cancel(ME, x._id);
        for (let i = 0; i < 2; i++) await add(ask);
        Object.assign(row(x._id), { status: 'held', heldAt: new Date(), holdId: 'B' });
        return n;
      }) as never);
      await service.retry(ME, x._id);
      expect(row(x._id)).toMatchObject({ status: 'held', holdId: 'B' });
      expect(queued(rows)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('열기 직전 확인은 통과했어도 DB 갱신이 늦어 그사이 held가 지나면 열지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { service, add, rows, model } = setup();
      const update = model.findOneAndUpdate.bind(model);
      // X를 여는 갱신이 61초 늦게 닿고, 그사이 다른 작업 둘이 한도를 채운다
      vi.spyOn(model, 'findOneAndUpdate').mockImplementationOnce(((...args: never[]) => ({
        lean: async () => {
          vi.setSystemTime(Date.now() + 61_000);
          for (let i = 0; i < 2; i++) await add(ask);
          return (update as (...a: never[]) => { lean: () => Promise<unknown> })(...args).lean();
        },
      })) as never);
      await expect(service.enqueue({ ...ask, userId: ME, input: {} })).rejects.toMatchObject({
        status: 429,
      });
      expect(queued(rows)).toBe(2);
      expect(rows.filter((r) => r.status === 'held')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('held를 남긴 뒤 한도 조회가 실패해도, 지나면 한도에서 빠지고 취소 · 다시 시도로 되살린다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { service, add, row, rows, model } = setup();
      const count = model.countDocuments.bind(model);
      const down = () => Promise.reject(new Error('db down'));
      // 넣기: 넣기 전 확인은 되고, 넣은 뒤 세다가 실패
      vi.spyOn(model, 'countDocuments')
        .mockImplementationOnce(count as never)
        .mockImplementationOnce(down as never);
      await expect(service.enqueue({ ...ask, userId: ME, input: {} })).rejects.toThrow('db down');
      const a = rows.find((r) => r.status === 'held')!;
      // 다시 시도: 잡은 뒤 세다가 실패
      const b = await add(ask);
      Object.assign(row(b._id), { status: 'failed' });
      vi.spyOn(model, 'countDocuments').mockImplementationOnce(down as never);
      await expect(service.retry(ME, b._id)).rejects.toThrow('db down');
      expect(row(b._id)).toMatchObject({ status: 'held' });

      // 지나기 전에는 둘 다 한도에 들어 새 질문은 429
      await expect(add(ask)).rejects.toMatchObject({ status: 429 });
      vi.setSystemTime(Date.now() + 61_000);
      // 지나면 한도에서 빠지고, 남은 held는 취소 · 다시 시도할 수 있다
      await service.cancel(ME, a._id.toString());
      expect(row(a._id.toString())).toMatchObject({ status: 'canceled' });
      expect(await service.retry(ME, b._id)).toMatchObject({ status: 'queued' });
      expect(row(b._id)).not.toHaveProperty('holdId');
      expect(await add(ask)).toMatchObject({ status: 'queued' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('API 서버 시계가 DB보다 빨라도, 세기와 열기가 같은 DB 시계로 판단해 한도를 넘지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setDbClockOffset(-1000); // DB가 1초 늦다
    try {
      const { service, add, rows, model } = setup();
      const count = model.countDocuments.bind(model);
      // A가 넣은 뒤 세는 동안 API 시계로 60.5초(DB로는 59.5초 — 아직 안 지남)가 지나고 B · C가 온다
      vi.spyOn(model, 'countDocuments')
        .mockImplementationOnce(count as never)
        .mockImplementationOnce((async (f: never) => {
          const n = await count(f);
          vi.setSystemTime(Date.now() + 60_500);
          await add(ask);
          await expect(add(ask)).rejects.toMatchObject({ status: 429 });
          return n;
        }) as never);
      await service.enqueue({ ...ask, userId: ME, input: {} });
      expect(queued(rows)).toBe(2);
    } finally {
      setDbClockOffset(0);
      vi.useRealTimers();
    }
  });
});
