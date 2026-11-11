// 진짜 MongoDB(replica set)에서 포인트 적립 트랜잭션이 되는지 보는 테스트.
// 확인하는 것: 적립이 성공하면 잔액과 장부가 함께 바뀌고, 장부 저장이 실패하면(자체 트랜잭션이든 바깥 트랜잭션이든) 잔액도 원래대로 돌아가고 장부가 안 생긴다.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 파일·실행마다 고유한 전용 DB(notelink_verify_point_<pid>_<시각>)만 쓰고 끝나면 그 DB만 지운다(다른 실제 DB 테스트 파일과 병렬로 돌아도 서로 지우지 않는다).
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/point-earn-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger, PointLedgerSchema } from '../src/modules/reward/schemas/point-ledger.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_point_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 포인트 적립 롤백 확인', () => {
    let moduleRef: TestingModule;
    let conn: Connection;
    let points: PointService;
    const col = (name: string) => conn.collection(name);

    // 테스트마다 새 사용자를 만들어 서로 영향이 없게 한다 (잔액 100)
    const newUser = async (): Promise<Types.ObjectId> => {
        const userId = new Types.ObjectId();
        await col('users').insertOne({ _id: userId, pointBalance: 100 });
        return userId;
    };
    const balanceOf = async (userId: Types.ObjectId): Promise<number> =>
        ((await col('users').findOne({ _id: userId })) as unknown as { pointBalance: number }).pointBalance;
    const ledgerCount = (userId: Types.ObjectId): Promise<number> => col('point_ledgers').countDocuments({ userId });

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: PointLedger.name, schema: PointLedgerSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            providers: [PointService],
        }).compile();
        await moduleRef.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        // 트랜잭션 안에서 컬렉션이 처음 만들어지는 일이 없도록 미리 만들어 둔다
        await Promise.all([conn.model(User.name).init(), conn.model(PointLedger.name).init()]);
        points = moduleRef.get(PointService);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await moduleRef?.close();
    });

    it('a) 성공하면 잔액이 늘고 장부에 한 줄이 남는다 (sessionId · studyDate 포함)', async () => {
        const userId = await newUser();
        const sessionId = new Types.ObjectId();

        const result = await points.earn(userId.toString(), 20, 'session_complete', '순공 세션 완료', undefined, {
            sessionId,
            studyDate: '2026-11-09',
        });

        expect(result).toBe(120);
        expect(await balanceOf(userId)).toBe(120);
        const ledger = await col('point_ledgers').find({ userId }).toArray();
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({
            amount: 20,
            balanceAfter: 120,
            reasonType: 'session_complete',
            description: '순공 세션 완료',
            studyDate: '2026-11-09',
        });
        expect((ledger[0] as unknown as { sessionId: Types.ObjectId }).sessionId.equals(sessionId)).toBe(true);
    });

    it('b) 자체 트랜잭션에서 장부 저장이 실패하면 잔액도 그대로이고 장부가 안 생긴다', async () => {
        const userId = await newUser();
        // 잔액을 늘린 다음 단계인 장부 저장을 한 번만 일부러 실패시킨다
        const spy = vi.spyOn(conn.model(PointLedger.name), 'create').mockRejectedValueOnce(new Error('일부러 낸 오류'));
        const error = await points.earn(userId.toString(), 20, 'session_complete', null).catch((e: unknown) => e);
        const calls = spy.mock.calls.length; // mockRestore()가 호출 기록을 지우므로 먼저 저장
        spy.mockRestore();

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('일부러 낸 오류');
        expect(calls).toBe(1); // 잔액을 늘린 뒤 장부 단계까지 실제로 갔다는 증거
        expect(await balanceOf(userId)).toBe(100);
        expect(await ledgerCount(userId)).toBe(0);
    });

    it('c) 바깥 트랜잭션이 중간에 실패하면 적립한 잔액과 장부가 함께 취소된다', async () => {
        const userId = await newUser();

        const error = await conn
            .transaction(async (session) => {
                await points.earn(userId.toString(), 20, 'session_complete', null, session);
                throw new Error('바깥 작업 실패');
            })
            .catch((e: unknown) => e);

        expect((error as Error).message).toBe('바깥 작업 실패');
        expect(await balanceOf(userId)).toBe(100);
        expect(await ledgerCount(userId)).toBe(0);
    });

    it('d) 같은 사용자의 earnQuiz(10)가 동시에 두 번 불려도 오늘 quiz_correct 합계는 40P이고 잔액도 40만 늘어난다', async () => {
        const userId = await newUser();

        const results = await Promise.all([points.earnQuiz(userId.toString(), 10), points.earnQuiz(userId.toString(), 10)]);

        expect(results.reduce((a, b) => a + b, 0)).toBe(40);
        const ledger = await col('point_ledgers').find({ userId, reasonType: 'quiz_correct' }).toArray();
        expect(ledger.reduce((sum, row) => sum + (row as unknown as { amount: number }).amount, 0)).toBe(40);
        expect(await balanceOf(userId)).toBe(140);
    });
});
