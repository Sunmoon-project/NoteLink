import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import type { AiJobDocument } from '../../src/modules/quiz/schemas/ai-job.schema.js';
import { matches, query } from './fake-collection.js';

type Row = Record<string, unknown> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type Filter = Record<string, unknown>;
type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
type Options = { returnDocument?: 'after'; sort?: { createdAt: -1 } };

export const PAST = new Date(Date.now() - 60_000);
export const LATER = new Date(Date.now() + 10 * 60_000);

/** ai_jobs 컬렉션을 메모리로 흉내 낸다. 서비스가 쓰는 create · find · findOne · countDocuments · findOneAndUpdate · deleteOne · exists만 만든다 */
export function createFakeJobs() {
  const rows: Row[] = [];
  let clock = 0;
  const model = {
    create: (data: Record<string, unknown>) => {
      const at = new Date(Date.UTC(2026, 10, 7, 0, 0, clock++));
      // 정해 둔 _id(NewAiJob.id)는 그대로 쓰고, MongoDB _id 고유 색인처럼 같은 id는 E11000으로 막는다
      const row: Row = {
        ...data,
        _id: (data['_id'] as Types.ObjectId | undefined) ?? new Types.ObjectId(),
        createdAt: at,
        updatedAt: at,
      };
      if (rows.some((r) => String(r._id) === String(row._id))) {
        return Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      }
      rows.push(row);
      return Promise.resolve({ toObject: () => ({ ...row }) });
    },
    // 두 번째 인자(projection)는 무시하고, sort는 createdAt 내림차순만(서비스가 쓰는 것)
    findOne: (filter: Filter, _projection?: unknown, options: Options = {}) => {
      const found = rows.filter((r) => matches(r, filter));
      if (options.sort) found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return query(found[0] ?? null);
    },
    // 두 번째 인자(projection)는 무시한다
    find: (filter: Filter, _projection?: unknown) =>
      query(rows.filter((r) => matches(r, filter)).map((r) => ({ ...r }))),
    countDocuments: (filter: Filter) =>
      Promise.resolve(rows.filter((r) => matches(r, filter)).length),
    deleteOne: (filter: Filter) => {
      const i = rows.findIndex((r) => matches(r, filter));
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({ deletedCount: i >= 0 ? 1 : 0 });
    },
    exists: (filter: Filter) => {
      const row = rows.find((r) => matches(r, filter));
      return Promise.resolve(row ? { _id: row._id } : null);
    },
    // 맞는 행을 모두 바꾼다($set · $unset). 지운 대상의 작업을 한 번에 멈출 때(cancelForTargets) 쓴다
    updateMany: (filter: Filter, update: Update) => {
      const found = rows.filter((r) => matches(r, filter));
      for (const row of found) {
        Object.assign(row, update.$set);
        for (const key of Object.keys(update.$unset ?? {})) delete row[key];
      }
      return Promise.resolve({ modifiedCount: found.length });
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
