// 진짜 MongoDB에서 발급 횟수 제한(UploadQuotaService)의 upsert · 유일 색인이 동시 요청에도 한도를 지키는지 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/upload-quota-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  UploadQuota,
  type UploadQuotaDocument,
  UploadQuotaSchema,
} from '../src/modules/upload/schemas/upload-quota.schema.js';
import {
  UPLOAD_ISSUE_LIMIT,
  UPLOAD_ISSUE_WINDOW_MS,
  UploadQuotaService,
} from '../src/modules/upload/upload-quota.service.js';
import { isLocalMongoUri } from './support/local-mongo.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = isLocalMongoUri(uri);
const dbName = `notelink_verify_upload_quota_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 발급 횟수 제한 확인', () => {
  let conn: Connection;
  let quotas: Model<UploadQuotaDocument>;
  let service: UploadQuotaService;
  // 구간 한가운데의 시각(시험 도중 구간이 바뀌지 않게)
  const start = Math.floor(Date.now() / UPLOAD_ISSUE_WINDOW_MS) * UPLOAD_ISSUE_WINDOW_MS;
  const now = new Date(start + UPLOAD_ISSUE_WINDOW_MS / 2);
  const user = () => new Types.ObjectId().toHexString();
  const docsOf = (userId: string) => quotas.find({ ownerId: new Types.ObjectId(userId) }).lean();

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    quotas = conn.model(
      UploadQuota.name,
      UploadQuotaSchema,
    ) as unknown as Model<UploadQuotaDocument>;
    await quotas.syncIndexes();
    service = new UploadQuotaService(quotas);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  it('사용자 · 구간 유일 색인과 만료(TTL) 색인이 만들어진다', async () => {
    const indexes = await quotas.collection.indexes();
    expect(indexes.find((i) => i.unique)?.key).toEqual({ ownerId: 1, windowStart: 1 });
    expect(indexes.find((i) => i.expireAfterSeconds === 0)?.key).toEqual({ expiresAt: 1 });
  });

  it('처음 받으면 문서를 만들고 구간이 끝나는 시각을 만료로 둔다', async () => {
    const id = user();
    expect(await service.reserve(id, now)).toEqual({ ok: true });
    const docs = await docsOf(id);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ count: 1, windowStart: new Date(start) });
    expect(docs[0]!.expiresAt).toEqual(new Date(start + UPLOAD_ISSUE_WINDOW_MS));
  });

  it('빈 구간에 동시에 받아도 문서는 하나이고 모두 센다', async () => {
    const id = user();
    const results = await Promise.all(Array.from({ length: 30 }, () => service.reserve(id, now)));
    expect(results.every((r) => r.ok)).toBe(true);
    const docs = await docsOf(id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.count).toBe(30);
  });

  it('동시에 한도보다 많이 받아도 한도까지만 내준다', async () => {
    const id = user();
    const results = await Promise.all(
      Array.from({ length: UPLOAD_ISSUE_LIMIT + 50 }, () => service.reserve(id, now)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(UPLOAD_ISSUE_LIMIT);
    expect(results.filter((r) => !r.ok)).toHaveLength(50);
    const docs = await docsOf(id);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.count).toBe(UPLOAD_ISSUE_LIMIT);
  });

  it('한도에 닿으면 거절하고 구간이 끝날 때까지 남은 시간을 알려 준다', async () => {
    const id = user();
    await quotas.collection.insertOne({
      ownerId: new Types.ObjectId(id),
      windowStart: new Date(start),
      count: UPLOAD_ISSUE_LIMIT,
      expiresAt: new Date(start + UPLOAD_ISSUE_WINDOW_MS),
    });
    expect(await service.reserve(id, now)).toEqual({
      ok: false,
      retryAfterMs: UPLOAD_ISSUE_WINDOW_MS / 2,
    });
    expect((await docsOf(id))[0]!.count).toBe(UPLOAD_ISSUE_LIMIT);
  });

  it('다음 구간은 처음부터 센다', async () => {
    const id = user();
    await quotas.collection.insertOne({
      ownerId: new Types.ObjectId(id),
      windowStart: new Date(start),
      count: UPLOAD_ISSUE_LIMIT,
      expiresAt: new Date(start + UPLOAD_ISSUE_WINDOW_MS),
    });
    const next = new Date(now.getTime() + UPLOAD_ISSUE_WINDOW_MS);
    expect(await service.reserve(id, next)).toEqual({ ok: true });
    expect(await docsOf(id)).toHaveLength(2);
  });
});
