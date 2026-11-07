import { AiJob } from '@notelink/shared';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AiJobsService, toAppJob } from '../src/ai-jobs/ai-jobs.service.js';
import type { AiJobDocument } from '../src/modules/quiz/schemas/ai-job.schema.js';

type Row = Record<string, unknown> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type Filter = Record<string, unknown>;
type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
type Options = { returnDocument?: 'after'; sort?: { createdAt: -1 } };

const same = (a: unknown, b: unknown) =>
  a instanceof Types.ObjectId || b instanceof Types.ObjectId ? String(a) === String(b) : a === b;

/** Mongoose 질의처럼 `.lean()`으로 결과를 받는다 */
const query = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

/** 서비스가 넘긴 조건을 그대로 적용한다(같음 · $in). 조건이 빠지면 테스트가 잡아낸다 */
const matches = (row: Row, filter: Filter) =>
  Object.entries(filter).every(([key, want]) =>
    want !== null && typeof want === 'object' && '$in' in want
      ? (want.$in as unknown[]).some((w) => same(row[key], w))
      : same(row[key], want),
  );

/** ai_jobs 컬렉션을 메모리로 흉내 낸다. 서비스가 쓰는 create · findOne · findOneAndUpdate · exists만 만든다 */
function createFakeJobs() {
  const rows: Row[] = [];
  let clock = 0;
  const model = {
    create: (data: Record<string, unknown>) => {
      const at = new Date(Date.UTC(2026, 10, 7, 0, 0, clock++));
      const row: Row = { ...data, _id: new Types.ObjectId(), createdAt: at, updatedAt: at };
      rows.push(row);
      return Promise.resolve({ toObject: () => ({ ...row }) });
    },
    findOne: (filter: Filter) => query(rows.find((r) => matches(r, filter)) ?? null),
    exists: (filter: Filter) => {
      const row = rows.find((r) => matches(r, filter));
      return Promise.resolve(row ? { _id: row._id } : null);
    },
    findOneAndUpdate: (filter: Filter, update: Update, options: Options = {}) => {
      const found = rows.filter((r) => matches(r, filter));
      if (options.sort) found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const row = found[0];
      if (!row) return query(null);
      const before = { ...row };
      Object.assign(row, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete row[key];
      return query(options.returnDocument === 'after' ? { ...row } : before);
    },
  };
  return { rows, model: model as unknown as Model<AiJobDocument> };
}

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
        lockedUntil: new Date(),
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

  it.each(['queued', 'running'])(
    '끝나지 않은(%s) 미리 만들기는 awaited로 이어받는다',
    async (status) => {
      const { service, add, row } = setup();
      const { _id } = await add(pregen);
      row(_id)['status'] = status;
      const job = await service.takeOverPregen(ME, 'material', NOTE);
      expect(job).toMatchObject({ _id, awaited: true });
      expect(row(_id)['awaited']).toBe(true);
    },
  );

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
