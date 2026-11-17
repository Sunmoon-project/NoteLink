import { Types } from 'mongoose';

/** auth_codes 문서(테스트용 모양) */
export interface CodeRow {
  _id: Types.ObjectId;
  email: string;
  purpose: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  consumedAt: Date | null;
  lastSentAt: Date;
  sendCount: number;
  windowEndsAt: Date;
  issueId: string;
  retainUntil: Date;
}

type Cond = { $lt?: number | Date; $lte?: number | Date; $gt?: number | Date };
type Filter = Partial<{ [K in keyof CodeRow]: CodeRow[K] | Cond | null }>;

const isCond = (v: unknown): v is Cond =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !(v instanceof Types.ObjectId);

const num = (v: Date | number) => (v instanceof Date ? v.getTime() : v);

/** 실제 Mongo처럼 필터에 적힌 항목만 따진다(적히지 않은 항목은 보지 않는다) */
function matches(row: CodeRow, filter: Filter): boolean {
  return (Object.keys(filter) as (keyof CodeRow)[]).every((key) => {
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
    if (want === null) return have === null;
    if (want instanceof Types.ObjectId) return (have as Types.ObjectId).equals(want);
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    return have === want;
  });
}

type Update = {
  $set?: Partial<CodeRow>;
  $inc?: Partial<Record<keyof CodeRow, number>>;
  /** 더 큰(늦은) 값만 반영한다 */
  $max?: Partial<Record<keyof CodeRow, Date | number>>;
};

function apply(row: CodeRow, update: Update): void {
  Object.assign(row, update.$set ?? {});
  for (const [k, value] of Object.entries(update.$max ?? {})) {
    const current = (row as unknown as Record<string, Date | number>)[k]!;
    if (num(value as Date | number) > num(current)) {
      (row as unknown as Record<string, Date | number>)[k] = value as Date | number;
    }
  }
  for (const [k, by] of Object.entries(update.$inc ?? {})) {
    (row as unknown as Record<string, number>)[k] =
      (row as unknown as Record<string, number>)[k]! + (by as number);
  }
}

/**
 * auth_codes 모델 대역. 조건부 업데이트의 의미(조건에 맞을 때만 한 번에 바뀐다)를 그대로 따른다.
 * 비동기 경계마다 `await`을 끼워, 동시에 시작한 요청들이 실제처럼 서로 끼어들 수 있게 한다.
 */
export function createFakeAuthCodes() {
  const rows: CodeRow[] = [];
  const tick = () => Promise.resolve();

  const model = {
    updateOne: async (filter: Filter, update: Update) => {
      await tick();
      const row = rows.find((r) => matches(r, filter));
      if (row) apply(row, update);
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    },
    findOneAndUpdate: (filter: Filter, update: Update, options?: { returnDocument?: string }) => ({
      lean: async () => {
        await tick();
        const row = rows.find((r) => matches(r, filter));
        if (!row) return null;
        const before = { ...row };
        apply(row, update);
        return options?.returnDocument === 'after' ? { ...row } : before;
      },
    }),
    findOne: (filter: Filter) => ({
      lean: async () => {
        await tick();
        const row = rows.find((r) => matches(r, filter));
        return row ? { ...row } : null;
      },
    }),
    create: async (data: Omit<CodeRow, '_id'>) => {
      await tick();
      // 이메일 + 목적 유일 인덱스: 이미 있으면 Mongo처럼 중복 키 오류(11000)를 던진다
      if (rows.some((r) => r.email === data.email && r.purpose === data.purpose)) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      const row: CodeRow = { ...data, _id: new Types.ObjectId() };
      rows.push(row);
      return row;
    },
  };
  return { model, rows };
}
