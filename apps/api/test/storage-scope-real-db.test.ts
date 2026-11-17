// 진짜 MongoDB에서 DB 구분값(StorageScopeService)이 DB마다 하나로 정해지는지 보는 테스트.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
import mongoose, { type Connection, type Model } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  StorageScope,
  type StorageScopeDocument,
  StorageScopeSchema,
} from '../src/modules/upload/schemas/storage-scope.schema.js';
import { StorageScopeService } from '../src/modules/upload/storage-scope.service.js';
import { isLocalMongoUri } from './support/local-mongo.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = isLocalMongoUri(uri);
const dbNames = ['a', 'b'].map((n) => `notelink_verify_scope_${n}_${process.pid}_${Date.now()}`);

describe.skipIf(!uri)('진짜 DB 저장소 구분값 확인', () => {
  let conns: Connection[] = [];
  const modelOf = (conn: Connection) =>
    conn.model(StorageScope.name, StorageScopeSchema) as unknown as Model<StorageScopeDocument>;

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conns = await Promise.all(
      dbNames.map((dbName) => mongoose.createConnection(uri!, { dbName }).asPromise()),
    );
  });

  afterAll(async () => {
    for (const conn of conns) {
      await conn.dropDatabase();
      await conn.close();
    }
  });

  it('서버 여럿이 동시에 처음 읽어도 한 DB에는 값이 하나만 생기고, 다시 켜도 그대로다', async () => {
    const model = modelOf(conns[0]!);
    const servers = Array.from({ length: 10 }, () => new StorageScopeService(model));
    const values = await Promise.all(servers.map((s) => s.get()));

    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(await model.countDocuments()).toBe(1);
    expect(await new StorageScopeService(model).get()).toBe(values[0]);
  });

  it('다른 DB는 다른 값을 갖는다', async () => {
    const [first, second] = await Promise.all(
      conns.map((conn) => new StorageScopeService(modelOf(conn)).get()),
    );
    expect(first).not.toBe(second);
  });
});
