import { Types } from 'mongoose';

/** upload_quotas 문서(테스트용 모양) */
export interface QuotaRow {
  ownerId: Types.ObjectId;
  windowStart: Date;
  count: number;
  expiresAt: Date;
}

type Filter = { ownerId: Types.ObjectId; windowStart: Date; count: { $lt: number } };
type Update = { $inc: { count: number }; $setOnInsert: { expiresAt: Date } };

const duplicateKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

/**
 * UploadQuotaService가 쓰는 `updateOne(…, { upsert: true })`만 흉내 낸 모델.
 * 조건에 맞는 문서가 있으면 올리고, 없으면 새로 만든다. 사용자 · 구간이 같은 문서가 이미 있으면(한도에 닿아 조건에
 * 안 맞는 경우) 진짜 유일 색인처럼 중복 키 오류를 낸다. 한 번의 호출은 중간에 끊기지 않는다.
 */
export function createFakeUploadQuotas() {
  const rows: QuotaRow[] = [];
  let race = false;
  const same = (r: QuotaRow, f: Filter) =>
    r.ownerId.equals(f.ownerId) && r.windowStart.getTime() === f.windowStart.getTime();
  const model = {
    updateOne: (f: Filter, u: Update, options: { upsert: boolean }) => {
      if (!options.upsert) return Promise.reject(new Error('upsert여야 한다'));
      if (race) {
        // 다른 요청이 먼저 문서를 만든 것처럼: 문서를 만들어 두고 이 호출은 중복 키로 실패
        race = false;
        rows.push({
          ownerId: f.ownerId,
          windowStart: f.windowStart,
          count: 0,
          expiresAt: u.$setOnInsert.expiresAt,
        });
        return Promise.reject(duplicateKey());
      }
      const existing = rows.find((r) => same(r, f));
      if (existing) {
        if (existing.count >= f.count.$lt) return Promise.reject(duplicateKey());
        existing.count += u.$inc.count;
        return Promise.resolve({ matchedCount: 1, upsertedCount: 0 });
      }
      rows.push({
        ownerId: f.ownerId,
        windowStart: f.windowStart,
        count: u.$inc.count,
        expiresAt: u.$setOnInsert.expiresAt,
      });
      return Promise.resolve({ matchedCount: 0, upsertedCount: 1 });
    },
  };
  return {
    model,
    rows,
    /** 다음 호출 한 번을 "처음 만들기가 겹친" 상황으로 만든다 */
    raceOnce: (on: boolean) => {
      race = on;
    },
  };
}
