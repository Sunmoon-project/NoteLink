// 진짜 MongoDB(replica set)에서 "한 사람의 열린 세션은 하나"가 지켜지는지 보는 테스트.
// 확인하는 것: 같은 사용자가 세션 시작을 동시에 두 번 불러도 running·paused 세션은 정확히 1개만 남고, 나머지는 ended(replaced)다.
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 파일·실행마다 고유한 전용 DB(notelink_verify_study_<pid>_<시각>)만 쓰고 끝나면 그 DB만 지운다(다른 실제 DB 테스트 파일과 병렬로 돌아도 서로 지우지 않는다).
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/study-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_study_${process.pid}_${Date.now()}`;
// 시험 기준 시각(서울 정오). 시험 데이터는 "오늘" 하루 기록만 만들어서, 진짜 시각으로 자정 직후(00:00~01:10)에 돌리면
// 70분 전 세션이 전날로 넘어가 그날 기록이 없어 어긋난다(실제로는 세션을 시작할 때 그날 기록을 만든다)
const BASE = new Date('2026-11-19T03:00:00Z');

describe.skipIf(!uri)('진짜 DB 세션 동시 시작 확인', () => {
    let moduleRef: TestingModule;
    let conn: Connection;
    let study: StudyService;
    const col = (name: string) => conn.collection(name);

    // 테스트마다 새 사용자를 만든다. 오늘 하루 기록과 공부 항목도 함께 만든다
    const newUserWithItem = async (): Promise<{ userId: Types.ObjectId; itemId: Types.ObjectId }> => {
        const userId = new Types.ObjectId();
        const itemId = new Types.ObjectId();
        await col('users').insertOne({ _id: userId, nickname: `u_${userId.toString()}`, pointBalance: 100 });
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
        // 날짜만 고정하고 시간은 그대로 흐르게 한다(타이머는 진짜)
        vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
        vi.setSystemTime(BASE);
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
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
        vi.useRealTimers();
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

    // ── 앱이 꺼진 세션: 마지막 신호(lastSeenAt)까지만 인정 ──
    const MIN = 60_000;
    const insertOpen = async (
        userId: Types.ObjectId,
        itemId: Types.ObjectId,
        over: Record<string, unknown>,
    ): Promise<Types.ObjectId> => {
        const _id = new Types.ObjectId();
        const startedAt = over.startedAt as Date;
        await col('study_sessions').insertOne({
            _id,
            userId,
            studyDate: seoulDate(startedAt),
            studyItemId: itemId,
            roomId: null,
            mode: 'personal',
            status: 'running',
            endedAt: null,
            durationSec: 0,
            departureCount: 0,
            endReason: null,
            isAbuse: false,
            pointsEarned: 0,
            pauses: [],
            ...over,
        });
        return _id;
    };
    const sessionDoc = (id: Types.ObjectId) => col('study_sessions').findOne({ _id: id });
    const balanceOf = async (userId: Types.ObjectId) =>
        ((await col('users').findOne({ _id: userId })) as unknown as { pointBalance: number }).pointBalance;

    it('c) 11분 전 시작 · 10분 전 신호인 세션을 새 타이머가 닫으면 약 3분(신호 + 2분)만 인정하고 포인트가 없다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const now = Date.now();
        const startedAt = new Date(now - 11 * MIN);
        const lastSeenAt = new Date(now - 10 * MIN);
        const old = await insertOpen(userId, itemId, { startedAt, lastSeenAt });

        await study.startSession(userId.toString(), { studyItemId: itemId.toString(), mode: 'personal' });

        const doc = await sessionDoc(old);
        expect(doc).toMatchObject({ status: 'ended', endReason: 'replaced', durationSec: 180, pointsEarned: 0 });
        expect(doc?.endedAt).toEqual(new Date(lastSeenAt.getTime() + 2 * MIN));
        expect(await balanceOf(userId)).toBe(100);
    });

    it('d) lastSeenAt이 없는 옛 세션은 startedAt + 2분까지만 인정한다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const startedAt = new Date(Date.now() - 11 * MIN);
        const old = await insertOpen(userId, itemId, { startedAt });

        await study.startSession(userId.toString(), { studyItemId: itemId.toString(), mode: 'personal' });

        const doc = await sessionDoc(old);
        expect(doc).toMatchObject({ status: 'ended', endReason: 'replaced', durationSec: 120, pointsEarned: 0 });
        expect(doc?.endedAt).toEqual(new Date(startedAt.getTime() + 2 * MIN));
    });

    it('e) 일시정지 중이던 세션도 같은 규칙이고, 열린 정지는 그 시각으로 닫힌다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const now = Date.now();
        const startedAt = new Date(now - 11 * MIN);
        const pausedAt = new Date(now - 9 * MIN);
        const old = await insertOpen(userId, itemId, {
            startedAt,
            status: 'paused',
            lastSeenAt: pausedAt,
            pauses: [{ startedAt: pausedAt, endedAt: null, reason: 'manual' }],
        });

        await study.startSession(userId.toString(), { studyItemId: itemId.toString(), mode: 'personal' });

        const doc = await sessionDoc(old);
        const cutoff = new Date(pausedAt.getTime() + 2 * MIN);
        expect(doc).toMatchObject({ status: 'ended', endReason: 'replaced', durationSec: 120, pointsEarned: 0 });
        expect(doc?.endedAt).toEqual(cutoff);
        expect((doc?.pauses as { endedAt: Date | null }[])[0]?.endedAt).toEqual(cutoff);
    });

    // 정산한 정지는 계산에 쓴 것과 같게 저장된다: 모두 startedAt ~ endedAt 안에 있고 끝이 시작보다 앞서지 않는다
    const expectPausesInside = (doc: Record<string, unknown> | null) => {
        const startedAt = (doc?.startedAt as Date).getTime();
        const endedAt = (doc?.endedAt as Date).getTime();
        for (const p of (doc?.pauses ?? []) as { startedAt: Date; endedAt: Date | null }[]) {
            expect(p.endedAt).not.toBeNull();
            expect(p.startedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
            expect(p.endedAt!.getTime()).toBeLessThanOrEqual(endedAt);
            expect(p.endedAt!.getTime()).toBeGreaterThanOrEqual(p.startedAt.getTime());
        }
    };

    it('h) lastSeenAt 없는 70분 전 세션의 10분 전 열린 정지는 마지막 신호로 쳐서 정지 시작 + 2분까지 인정하고, 저장된 정지도 앞뒤가 맞는다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const now = Date.now();
        const startedAt = new Date(now - 70 * MIN);
        const pausedAt = new Date(now - 10 * MIN);
        const old = await insertOpen(userId, itemId, {
            startedAt,
            status: 'paused',
            pauses: [{ startedAt: pausedAt, endedAt: null, reason: 'manual' }],
        });

        await study.startSession(userId.toString(), { studyItemId: itemId.toString(), mode: 'personal' });

        const doc = await sessionDoc(old);
        expect(doc).toMatchObject({ status: 'ended', endReason: 'replaced', durationSec: 3600 }); // 70분 전 ~ 정지 시작(10분 전)
        expect(doc?.endedAt).toEqual(new Date(pausedAt.getTime() + 2 * MIN));
        expect((doc?.pauses as unknown[]).length).toBe(1);
        expectPausesInside(doc);
    });

    it('i) lastSeenAt보다 뒤에 시작한 정지가 있는 데이터 이상이어도 정지를 신호로 치고, 저장된 정지가 세션 범위 안에 있다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const now = Date.now();
        const old = await insertOpen(userId, itemId, {
            startedAt: new Date(now - 70 * MIN),
            lastSeenAt: new Date(now - 60 * MIN),
            pauses: [{ startedAt: new Date(now - 30 * MIN), endedAt: new Date(now - 20 * MIN), reason: 'manual' }],
        });

        await study.startSession(userId.toString(), { studyItemId: itemId.toString(), mode: 'personal' });

        const doc = await sessionDoc(old);
        expect(doc?.endedAt).toEqual(new Date(now - 18 * MIN)); // 마지막 신호 = 정지 끝(20분 전) + 2분
        expect(doc?.durationSec).toBe(52 * 60 - 10 * 60); // 70분 전 ~ 18분 전 = 52분, 정지 10분 제외
        expectPausesInside(doc);
        expect((doc?.pauses as unknown[]).length).toBe(1);
    });

    it('f) 정상 종료(end)는 신호가 오래돼도 종료 시각까지 그대로 센다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const now = Date.now();
        const id = await insertOpen(userId, itemId, {
            startedAt: new Date(now - 11 * MIN),
            lastSeenAt: new Date(now - 10 * MIN),
        });

        const result = await study.end(userId.toString(), id.toString(), { clientDurationSec: 0, endReason: 'manual' });

        expect(result?.durationSec).toBeGreaterThanOrEqual(660);
        expect(result?.durationSec).toBeLessThan(665);
        expect(result?.pointsEarned).toBe(20);
        expect(await balanceOf(userId)).toBe(120);
    });

    it('g) 하트비트는 lastSeenAt을 올리되 뒤로 돌리지 않고, 끝난 세션 · 남의 세션은 거부한다', async () => {
        const { userId, itemId } = await newUserWithItem();
        const now = Date.now();
        const stale = await insertOpen(userId, itemId, {
            startedAt: new Date(now - 11 * MIN),
            lastSeenAt: new Date(now - 10 * MIN),
        });

        expect(await study.heartbeat(userId.toString(), stale.toString())).toBe(true);
        const bumped = (await sessionDoc(stale))?.lastSeenAt as Date;
        expect(bumped.getTime()).toBeGreaterThanOrEqual(now);

        // 미래 값(시계가 앞선 서버가 쓴 값)은 지금 시각의 하트비트가 뒤로 돌리지 않는다
        const future = new Date(now + 60 * MIN);
        await col('study_sessions').updateOne({ _id: stale }, { $set: { lastSeenAt: future } });
        expect(await study.heartbeat(userId.toString(), stale.toString())).toBe(true);
        expect((await sessionDoc(stale))?.lastSeenAt).toEqual(future);

        expect(await study.heartbeat(new Types.ObjectId().toString(), stale.toString())).toBe(false);
        expect(await study.heartbeat(userId.toString(), 'not-an-id')).toBe(false);
        await study.end(userId.toString(), stale.toString(), { clientDurationSec: 0, endReason: 'manual' });
        expect(await study.heartbeat(userId.toString(), stale.toString())).toBe(false);
    });
});
