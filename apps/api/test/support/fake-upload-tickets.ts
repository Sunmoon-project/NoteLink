import { Types } from 'mongoose';

/** upload_tickets 문서(테스트용 모양) */
export interface TicketRow {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  blobName: string;
  maxBytes: number;
  status: string;
  expiresAt: Date;
  checkedAt: Date | null;
  createdAt: Date;
}

type Range = { $gte?: Date; $lte?: Date };
type Filter = {
  _id?: Types.ObjectId;
  ownerId?: Types.ObjectId;
  status?: string;
  checkedAt?: null;
  createdAt?: Range;
  expiresAt?: Range;
};

const inRange = (value: Date, r?: Range) =>
  !r || ((!r.$gte || value >= r.$gte) && (!r.$lte || value <= r.$lte));

/** 서비스가 넘긴 조건을 있는 그대로 해석한다. 조건에 없는 항목은 따지지 않는다 */
function matches(r: TicketRow, f: Filter): boolean {
  return (
    (f._id === undefined || r._id.equals(f._id)) &&
    (f.ownerId === undefined || r.ownerId.equals(f.ownerId)) &&
    (f.status === undefined || r.status === f.status) &&
    (!('checkedAt' in f) || r.checkedAt === f.checkedAt) &&
    inRange(r.createdAt, f.createdAt) &&
    inRange(r.expiresAt, f.expiresAt)
  );
}

/** UploadService · UploadSweeper가 쓰는 만큼만 흉내 낸 모델. now로 createdAt을 정한다 */
export function createFakeUploadTickets(now: () => Date = () => new Date()) {
  const rows: TicketRow[] = [];
  let failCreate = false;
  const model = {
    countDocuments: (f: Filter) => Promise.resolve(rows.filter((r) => matches(r, f)).length),
    create: (doc: Pick<TicketRow, 'ownerId' | 'blobName' | 'maxBytes' | 'expiresAt'>) => {
      if (failCreate) return Promise.reject(new Error('DB 쓰기 실패'));
      const row: TicketRow = {
        _id: new Types.ObjectId(),
        status: 'issued',
        checkedAt: null,
        createdAt: now(),
        ...doc,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    find: (f: Filter) => {
      let found = rows.filter((r) => matches(r, f));
      const query = {
        sort: () => {
          found = [...found].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
          return query;
        },
        limit: (n: number) => {
          found = found.slice(0, n);
          return query;
        },
        lean: () => Promise.resolve(found.map((r) => ({ ...r }))),
      };
      return query;
    },
    deleteOne: (f: Filter) => {
      const i = rows.findIndex((r) => matches(r, f));
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({ deletedCount: i >= 0 ? 1 : 0 });
    },
    updateOne: (f: Filter, update: { $set: Partial<TicketRow> }) => {
      const row = rows.find((r) => matches(r, f));
      if (row) Object.assign(row, update.$set);
      return Promise.resolve({ modifiedCount: row ? 1 : 0 });
    },
  };
  return {
    model,
    rows,
    failNextCreates: (on: boolean) => {
      failCreate = on;
    },
  };
}
