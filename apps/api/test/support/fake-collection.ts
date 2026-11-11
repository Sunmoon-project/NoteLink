import type { Model } from 'mongoose';
import { Types } from 'mongoose';

export type Row = Record<string, unknown> & { _id: Types.ObjectId };
type Filter = Record<string, unknown>;

const same = (a: unknown, b: unknown) =>
  a instanceof Types.ObjectId || b instanceof Types.ObjectId
    ? String(a) === String(b)
    : a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : a === b;

type Ops = { $in?: unknown[]; $ne?: unknown; $lte?: Date; $gt?: Date; $lt?: number };
const isOps = (v: unknown): v is Ops =>
  v !== null && typeof v === 'object' && !(v instanceof Types.ObjectId) && !(v instanceof Date);
const time = (v: unknown) => (v instanceof Date ? v.getTime() : NaN);

/** 서비스가 쓰는 $expr 하나만: { $gt: ['$필드', { $subtract: ['$$NOW', ms] }] }(DB 시각 기준 만료). 다른 꼴은 맞지 않음 */
type Expr = { $gt?: [string, { $subtract?: [string, number] }] };
function expr(row: Record<string, unknown>, e: Expr): boolean {
  const [field, rhs] = e.$gt ?? [];
  const [now, ms] = rhs?.$subtract ?? [];
  if (!field?.startsWith('$') || now !== '$$NOW' || typeof ms !== 'number') return false;
  return time(row[field.slice(1)]) > Date.now() - ms;
}

/**
 * 서비스가 넘긴 조건을 그대로 적용한다(같음 · $in · $ne · $lte · $gt · $lt · $or). ObjectId는 문자열로 비교하고,
 * MongoDB처럼 `null` 조건은 필드가 없는 문서에도 맞는다. 모르는 조건은 맞지 않아 테스트가 잡아낸다
 */
export function matches(row: Record<string, unknown>, filter: Filter): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (key === '$or') return (want as Filter[]).some((f) => matches(row, f));
    if (key === '$expr') return expr(row, want as Expr);
    const value = row[key];
    if (want === null) return value === null || value === undefined;
    if (!isOps(want)) return same(value, want);
    if (want.$in) return want.$in.some((w) => same(value, w));
    if ('$ne' in want) {
      return want.$ne === null ? value !== null && value !== undefined : !same(value, want.$ne);
    }
    if (want.$lte) return time(value) <= want.$lte.getTime();
    if (want.$gt) return time(value) > want.$gt.getTime();
    if (want.$lt !== undefined) return typeof value === 'number' && value < want.$lt;
    return false;
  });
}

/** structuredClone은 ObjectId를 일반 객체로 바꾸므로 ObjectId · Date는 그대로 두고 복사한다 */
function clone<T>(value: T): T {
  if (value instanceof Types.ObjectId || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)])) as T;
  }
  return value;
}

/** Mongoose 질의처럼 `.lean()`으로 결과를 받는다 */
export const query = <T>(value: T) => ({ lean: () => Promise.resolve(value) });

/**
 * 메모리 컬렉션. 서비스가 쓰는 create · find(.sort) · findOne · findOneAndUpdate($set)만 만든다.
 * unique는 MongoDB 고유 색인처럼 create를 E11000으로 막는다(같은 키의 행이 이미 있으면).
 */
/** D는 서비스가 받는 모델의 문서 타입(예: QuizSetDocument) */
export function createFakeCollection<D>(unique?: (a: Row, b: Row) => boolean) {
  const rows: Row[] = [];
  let clock = 0;
  const model = {
    create: (data: Record<string, unknown>) => {
      const at = new Date(Date.UTC(2026, 10, 8, 0, 0, clock++));
      const row: Row = {
        createdAt: at,
        updatedAt: at,
        ...data,
        _id: (data['_id'] as Types.ObjectId) ?? new Types.ObjectId(),
      };
      if (unique && rows.some((r) => unique(r, row))) {
        return Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
      }
      rows.push(row);
      // Mongoose 문서처럼 필드도 읽을 수 있게 한다
      return Promise.resolve({ ...clone(row), toObject: () => clone(row) });
    },
    findOne: (filter: Filter) => {
      const row = rows.find((r) => matches(r, filter));
      return query(row ? clone(row) : null);
    },
    find: (filter: Filter) => {
      let found = rows.filter((r) => matches(r, filter));
      const chain = {
        sort: (by: Record<string, 1 | -1>) => {
          const [[key, dir]] = Object.entries(by) as [[string, 1 | -1]];
          found = [...found].sort(
            (a, b) => dir * ((a[key] as Date).getTime() - (b[key] as Date).getTime()),
          );
          return chain;
        },
        limit: (n: number) => {
          found = found.slice(0, n);
          return chain;
        },
        lean: () => Promise.resolve(found.map((r) => clone(r))),
      };
      return chain;
    },
    findOneAndUpdate: (
      filter: Filter,
      update: { $set?: Record<string, unknown> },
      options: { returnDocument?: 'after' } = {},
    ) => {
      const row = rows.find((r) => matches(r, filter));
      if (!row) return query(null);
      const before = clone(row);
      Object.assign(row, update.$set);
      return query(options.returnDocument === 'after' ? clone(row) : before);
    },
  };
  return { rows, model: model as unknown as Model<D> };
}
