import { Types } from 'mongoose';

/** refresh_tokens 문서(테스트용 모양) */
export interface TokenRow {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  device?: unknown;
  expiresAt: Date;
  revokedAt: Date | null;
}

type Filter = {
  tokenHash?: string;
  userId?: Types.ObjectId;
  revokedAt?: null;
  expiresAt?: { $gt: Date };
};

/**
 * 서비스가 넘긴 조건(해시 · 사용자 · 폐기 여부 · 만료)을 있는 그대로 해석한다.
 * 조건에 없는 항목은 따지지 않으므로, 서비스가 `userId`만으로 폐기하는 식으로 잘못 구현돼도 그대로 드러난다.
 */
function matches(r: TokenRow, f: Filter): boolean {
  return (
    (f.tokenHash === undefined || r.tokenHash === f.tokenHash) &&
    (f.userId === undefined || r.userId.equals(f.userId)) &&
    (!('revokedAt' in f) || r.revokedAt === f.revokedAt) &&
    (!f.expiresAt || r.expiresAt > f.expiresAt.$gt)
  );
}

/** refresh_tokens 모델 대역. 토큰 발급 · 갱신(rotate) · 폐기(revoke)가 쓰는 연산을 지원한다 */
export function createFakeRefreshTokens() {
  const rows: TokenRow[] = [];
  const model = {
    create: (data: Omit<TokenRow, '_id' | 'revokedAt'>) => {
      const row: TokenRow = { ...data, _id: new Types.ObjectId(), revokedAt: null };
      rows.push(row);
      return Promise.resolve(row);
    },
    findOne: (f: Filter) => Promise.resolve(rows.find((r) => matches(r, f)) ?? null),
    findOneAndUpdate: (f: Filter, update: { revokedAt: Date }) => {
      const row = rows.find((r) => matches(r, f));
      if (!row) return Promise.resolve(null);
      const before = { ...row };
      row.revokedAt = update.revokedAt;
      return Promise.resolve(before);
    },
    updateOne: (f: Filter, update: { revokedAt: Date }) => {
      const row = rows.find((r) => matches(r, f));
      if (row) row.revokedAt = update.revokedAt;
      return Promise.resolve({ matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 });
    },
    deleteOne: (f: { _id: Types.ObjectId }) => {
      const i = rows.findIndex((r) => r._id.equals(f._id));
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({});
    },
  };
  return { model, rows };
}
