// 진짜 MongoDB(replica set)에서 "한 사람의 열린 세션은 하나"가 지켜지는지 보는 테스트.
// 확인하는 것: 같은 사용자가 세션 시작을 동시에 두 번 불러도 running·paused 세션은 정확히 1개만 남고, 나머지는 ended(replaced)다.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 전용 DB(notelink_verify_tmp)만 쓰고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/study-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { DailyRecord, DailyRecordSchema } from '../src/modules/progress/schemas/daily-record.schema.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger, PointLedgerSchema } from '../src/modules/reward/schemas/point-ledger.schema.js';
import { StudySession, StudySessionSchema } from '../src/modules/session/schemas/study-session.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';
import { StudyService } from '../src/modules/session/study.service.js';
import { seoulDate } from '../src/modules/session/study-time.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);

describe.skipIf(!uri)('진짜 DB 세션 동시 시작 확인', () => {
    let moduleRef: TestingModule;
    let conn: Connection;
    let study: StudyService;
    const col = (name: string) => conn.collection(name);

    // 테스트마다 새 사용자를 만든다. 오늘 하루 기록과 공부 항목도 함께 만든다
    const newUserWithItem = async (): Promise<{ userId: Types.ObjectId; itemId: Types.ObjectId }> => {
        const userId = new Types.ObjectId();
        const itemId = new Types.ObjectId();
        await col('users').insertOne({ _id: userId, pointBalance: 100 });
        await col('daily_records').insertOne({
            userId,
            studyDate: seoulDate(new Date()),
            totalSec: 0,
            personalSec: 0,
            roomSec: 0,
            streakOk: false,
            items: [{ _id: itemId, title: '동시 시작 확인', subjectId: null, subjectName: null, goalMin: null, accumulatedSec: 0 }],
        });
        return { userId, itemId };
    };
    const sessionsOf = async (userId: Types.ObjectId): Promise<{ status: string; endReason: string | null }[]> =>
        (await col('study_sessions').find({ userId }).toArray()) as unknown as { status: string; endReason: string | null }[];

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName: 'notelink_verify_tmp', serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: StudySession.name, schema: StudySessionSchema },
                    { name: DailyRecord.name, schema: DailyRecordSchema },
                    { name: Subject.name, schema: SubjectSchema },
                    { name: PointLedger.name, schema: PointLedgerSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            providers: [StudyService, PointService],
        }).compile();
        await moduleRef.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        // 인덱스(열린 세션은 하나)가 확실히 만들어지게 하고, 트랜잭션 안에서 컬렉션이 처음 만들어지는 일이 없게 미리 만들어 둔다
        await conn.model(StudySession.name).syncIndexes();
        await Promise.all([
            conn.model(DailyRecord.name).init(),
            conn.model(Subject.name).init(),
            conn.model(PointLedger.name).init(),
            conn.model(User.name).init(),
        ]);
        study = moduleRef.get(StudyService);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await moduleRef?.close();
    });

    it('a) DB에 "사용자당 열린 세션은 하나" 부분 유니크 인덱스가 있고, 열린 세션을 직접 두 개 넣으면 거부된다', async () => {
        const indexes = await col('study_sessions').indexes();
        expect(indexes).toContainEqual(
            expect.objectContaining({
                key: { userId: 1 },
                unique: true,
                partialFilterExpression: { status: { $in: ['running', 'paused'] } },
            }),
        );

        const userId = new Types.ObjectId();
        const open = (status: string) => ({ userId, status, studyDate: '2026-11-09', startedAt: new Date() });
        await col('study_sessions').insertOne(open('running'));
        await expect(col('study_sessions').insertOne(open('paused'))).rejects.toMatchObject({ code: 11000 });
        // 끝난 세션은 몇 개든 괜찮다
        await col('study_sessions').insertOne(open('ended'));
        await col('study_sessions').insertOne(open('ended'));
    });

    it('b) 같은 사용자가 세션 시작을 동시에 두 번 불러도 열린 세션은 정확히 1개이고 나머지는 ended(replaced)다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const dto = { studyItemId: itemId.toString(), mode: 'personal' } as const;

        // 둘 다 오류 없이 끝나야 한다 (늦은 쪽은 중복 키 · 쓰기 충돌 뒤 다시 실행해 성공)
        const [first, second] = await Promise.all([
            study.startSession(userId.toString(), dto),
            study.startSession(userId.toString(), dto),
        ]);
        expect(first).toBeDefined();
        expect(second).toBeDefined();

        const sessions = await sessionsOf(userId);
        expect(sessions).toHaveLength(2);
        expect(sessions.filter((s) => s.status === 'running' || s.status === 'paused')).toHaveLength(1);
        const ended = sessions.filter((s) => s.status === 'ended');
        expect(ended).toHaveLength(1);
        expect(ended[0]?.endReason).toBe('replaced');
    });
});
