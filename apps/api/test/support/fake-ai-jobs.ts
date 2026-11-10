import type { Model } from 'mongoose';
import { Types } from 'mongoose';

import type { AiJobDocument } from '../../src/modules/quiz/schemas/ai-job.schema.js';

type Row = Record<string, unknown> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
type Filter = Record<string, unknown>;
type Update = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
type Options = { returnDocument?: 'after'; sort?: { createdAt: -1 } };

const same = (a: unknown, b: unknown) =>
  a instanceof Types.ObjectId || b instanceof Types.ObjectId ? String(a) === String(b) : a === b;

/** Mongoose 질의처럼 `.lean()`으로 결과를 받는다 */
const query = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

type Ops = { $in?: unknown[]; $lte?: Date; $gt?: Date; $lt?: number };
const isOps = (want: unknown): want is Ops =>
  want !== null && typeof want === 'object' && !(want instanceof Types.ObjectId);
const time = (v: unknown) => (v instanceof Date ? v.getTime() : NaN);

/**
 * 서비스가 넘긴 조건을 그대로 적용한다(같음 · $in · $lte · $gt · $or). 조건이 빠지면 테스트가 잡아낸다.
 * MongoDB처럼 `null` 조건은 필드가 없는 문서에도 맞는다
 */
function matches(row: Row, filter: Filter): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (key === '$or') return (want as Filter[]).some((f) => matches(row, f));
    const value = row[key];
    if (want === null) return value === null || value === undefined;
    if (!isOps(want)) return same(value, want);
    if (want.$in) return want.$in.some((w) => same(value, w));
    if (want.$lte) return time(value) <= want.$lte.getTime();
    if (want.$gt) return time(value) > want.$gt.getTime();
    if (want.$lt !== undefined) return typeof value === 'number' && value < want.$lt;
    return false;
  });
}

export const PAST = new Date(Date.now() - 60_000);
export const LATER = new Date(Date.now() + 10 * 60_000);

/** ai_jobs 컬렉션을 메모리로 흉내 낸다. 서비스가 쓰는 create · findOne · countDocuments · findOneAndUpdate · deleteOne · exists만 만든다 */
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
