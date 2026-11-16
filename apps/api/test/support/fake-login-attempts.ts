import { Types } from 'mongoose';

/** login_attempts 문서(테스트용 모양) */
export interface AttemptRow {
  _id: Types.ObjectId;
  email: string;
  attempts: number;
  lastAttemptAt: Date;
  expiresAt: Date;
}

type Cond = { $lt?: number | Date; $lte?: number | Date; $gt?: number | Date };
type Filter = Partial<{ [K in keyof AttemptRow]: AttemptRow[K] | Cond }>;

const isCond = (v: unknown): v is Cond =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !(v instanceof Types.ObjectId);
const num = (v: Date | number) => (v instanceof Date ? v.getTime() : v);

/** 실제 Mongo처럼 필터에 적힌 항목만 따진다(적히지 않은 항목은 보지 않는다) */
function matches(row: AttemptRow, filter: Filter): boolean {
  return (Object.keys(filter) as (keyof AttemptRow)[]).every((key) => {
    const want = filter[key];
    const have = row[key];
    if (isCond(want)) {
      const h = num(have as Date | number);
      return (
        (want.$lt === undefined || h < num(want.$lt)) &&
        (want.$lte === undefined || h <= num(want.$lte)) &&
        (want.$gt === undefined || h > num(want.$gt))
      );
    }
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    return have === want;
  });
}

type Update = { $set?: Partial<AttemptRow>; $inc?: Partial<Record<keyof AttemptRow, number>> };

function apply(row: AttemptRow, update: Update): void {
  Object.assign(row, update.$set ?? {});
  for (const [k, by] of Object.entries(update.$inc ?? {})) {
    const r = row as unknown as Record<string, number>;
    r[k] = r[k]! + (by as number);
  }
}

/**
 * login_attempts 모델 대역. 조건부 업데이트의 의미(조건에 맞을 때만 한 번에 바뀐다)를 그대로 따르고,
 * 비동기 경계마다 `await`을 끼워 동시에 시작한 요청들이 실제처럼 서로 끼어들 수 있게 한다.
 */
export function createFakeLoginAttempts() {
  const rows: AttemptRow[] = [];
  const tick = () => Promise.resolve();

  const model = {
    updateOne: async (filter: Filter, update: Update) => {
      await tick();
      const row = rows.find((r) => matches(r, filter));
      if (row) apply(row, update);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    },
    findOne: (filter: Filter) => ({
      lean: async () => {
        await tick();
        const row = rows.find((r) => matches(r, filter));
        return row ? { ...row } : null;
      },
    }),
    create: async (data: Omit<AttemptRow, '_id'>) => {
      await tick();
      // 이메일 유일 인덱스: 이미 있으면 Mongo처럼 중복 키 오류(11000)를 던진다
      if (rows.some((r) => r.email === data.email)) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      const row: AttemptRow = { ...data, _id: new Types.ObjectId() };
      rows.push(row);
      return row;
    },
    deleteOne: async (filter: Filter) => {
      await tick();
      const i = rows.findIndex((r) => matches(r, filter));
      if (i >= 0) rows.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
  };
  return { model, rows };
}
