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

/** ai_jobs 컬렉션을 메모리로 흉내 낸다. 서비스가 쓰는 create · findOne · findOneAndUpdate · exists만 만든다 */
export function createFakeJobs() {
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
