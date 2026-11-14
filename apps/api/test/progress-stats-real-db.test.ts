// 진짜 MongoDB(replica set)에서 월간 캘린더(FR-09-02~04)와 기간별 누적 기록(FR-09-05~07)을 확인하는 테스트.
// 확인하는 것: 달 길이와 level, range별 합계 · 공부한 날 · 최장 연속, peakHour(기록 없음 -1 · 어뷰징 제외 · 서울 시각),
// 서울 자정에 오늘이 바뀌는 것, 다른 사람 기록이 섞이지 않는 것, 연속 학습일(streakDays)과 GET /users/me 연결.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일·실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/progress-stats-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { ProgressService, STREAK_BATCH_SIZE } from '../src/modules/progress/progress.service.js';
import { Todo, TodoSchema } from '../src/modules/calendar/schemas/todo.schema.js';
import { DailyRecord, DailyRecordSchema } from '../src/modules/progress/schemas/daily-record.schema.js';
import { WeeklyGoal, WeeklyGoalSchema } from '../src/modules/progress/schemas/weekly-goal.schema.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger, PointLedgerSchema } from '../src/modules/reward/schemas/point-ledger.schema.js';
import { StudySession, StudySessionSchema } from '../src/modules/session/schemas/study-session.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';
import { StudyService } from '../src/modules/session/study.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_progress_stats_${process.pid}_${Date.now()}`;

// 서울 목요일 정오. 오늘은 2026-11-12
const NOW = new Date('2026-11-12T03:00:00.000Z');
const ago = (n: number): string => new Date(Date.UTC(2026, 10, 12 - n)).toISOString().slice(0, 10);

describe.skipIf(!isLocal)('진짜 DB 월간 캘린더 · 누적 기록 확인', () => {
    let moduleRef: TestingModule;
    let conn: Connection;
    let progress: ProgressService;
    let study: StudyService;
    let users: UsersService;
    const col = (name: string) => conn.collection(name);

    const day = async (userId: Types.ObjectId, studyDate: string, totalSec: number): Promise<void> => {
        await col('daily_records').insertOne({
            userId,
            studyDate,
            totalSec,
            personalSec: totalSec,
            roomSec: 0,
            streakOk: false,
            items: [],
        });
    };
    // 끝난 세션을 바로 넣는다 (peakHour 확인용)
    const endedSession = async (userId: Types.ObjectId, startedAt: Date, durationSec: number, isAbuse = false): Promise<void> => {
        await col('study_sessions').insertOne({
            userId,
            studyDate: new Date(startedAt.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10),
            studyItemId: null,
            roomId: null,
            mode: 'personal',
            status: 'ended',
            startedAt,
            endedAt: new Date(startedAt.getTime() + durationSec * 1000),
            durationSec,
            departureCount: 0,
            endReason: 'user',
            isAbuse,
            pointsEarned: 0,
            pauses: [],
        });
    };

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: DailyRecord.name, schema: DailyRecordSchema },
                    { name: WeeklyGoal.name, schema: WeeklyGoalSchema },
                    { name: Todo.name, schema: TodoSchema },
                    { name: StudySession.name, schema: StudySessionSchema },
                    { name: Subject.name, schema: SubjectSchema },
                    { name: PointLedger.name, schema: PointLedgerSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            providers: [ProgressService, StudyService, PointService, UsersService],
        }).compile();
        await moduleRef.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        await conn.model(DailyRecord.name).syncIndexes();
        await conn.model(StudySession.name).syncIndexes();
        await Promise.all([conn.model(Subject.name).init(), conn.model(PointLedger.name).init(), conn.model(User.name).init()]);
        progress = moduleRef.get(ProgressService);
        study = moduleRef.get(StudyService);
        users = moduleRef.get(UsersService);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await moduleRef?.close();
    });

    it('month: 달 길이(28 · 29 · 30 · 31일)와 level 경계, 다른 달 · 다른 사람 기록은 섞이지 않는다', async () => {
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        await day(me, '2026-02-01', 1);
        await day(me, '2026-02-28', 2 * 3600);
        await day(me, '2026-03-01', 99999); // 다음 달
        await day(me, '2026-01-31', 99999); // 지난달
        await day(other, '2026-02-02', 99999);

        const feb = await progress.month(me.toString(), '2026-02');
        expect(feb).toHaveLength(28);
        expect(feb[0]).toEqual({ studyDate: '2026-02-01', level: 1, hasTodo: false });
        expect(feb[1]).toEqual({ studyDate: '2026-02-02', level: 0, hasTodo: false }); // 다른 사람 기록은 안 보인다
        expect(feb[27]).toEqual({ studyDate: '2026-02-28', level: 4, hasTodo: false });

        expect(await progress.month(me.toString(), '2028-02')).toHaveLength(29);
        expect(await progress.month(me.toString(), '2026-04')).toHaveLength(30);
        expect(await progress.month(me.toString(), '2026-12')).toHaveLength(31);
    });

    it('month: level 경계값 (0 · 1초 · 30분 · 1시간 · 2시간)', async () => {
        const me = new Types.ObjectId();
        const secs = [0, 1, 30 * 60 - 1, 30 * 60, 60 * 60 - 1, 60 * 60, 2 * 3600 - 1, 2 * 3600];
        for (const [i, sec] of secs.entries()) await day(me, `2026-11-${String(i + 1).padStart(2, '0')}`, sec);
        const nov = await progress.month(me.toString(), '2026-11');
        expect(nov.slice(0, 8).map((d) => d.level)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
    });

    it('stats: 기록이 없으면 0 · peakHour -1 · 잔디 126일', async () => {
        const stats = await progress.stats(new Types.ObjectId().toString(), 'all', NOW);
        expect(stats).toMatchObject({ totalSec: 0, studyDays: 0, longestStreak: 0, peakHour: -1 });
        expect(stats.heatmap).toHaveLength(126);
        expect(stats.heatmap[125]?.studyDate).toBe('2026-11-12');
    });

    it('stats: range마다 합계 · 공부한 날 · 최장 연속이 달라지고, 다른 사람 기록은 섞이지 않는다', async () => {
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        for (const n of [100, 101, 102, 103, 104]) await day(me, ago(n), 1000);
        for (const n of [60, 61, 62]) await day(me, ago(n), 2000);
        for (const n of [0, 1]) await day(me, ago(n), 3000);
        for (const n of [0, 1, 2, 3, 4, 5]) await day(other, ago(n), 50000);

        const d30 = await progress.stats(me.toString(), '30d', NOW);
        const d90 = await progress.stats(me.toString(), '90d', NOW);
        const all = await progress.stats(me.toString(), 'all', NOW);
        expect([d30.totalSec, d90.totalSec, all.totalSec]).toEqual([6000, 12000, 17000]);
        expect([d30.studyDays, d90.studyDays, all.studyDays]).toEqual([2, 5, 10]);
        expect([d30.longestStreak, d90.longestStreak, all.longestStreak]).toEqual([2, 3, 5]);
        // 잔디는 range와 상관없이 126일이고, 100일 전 기록(1000초 = level 1)도 보인다
        expect(d30.heatmap).toHaveLength(126);
        expect(d30.heatmap.find((h) => h.studyDate === ago(100))?.level).toBe(1);
    });

    it('stats: 90d · 30d는 오늘 포함 90일 · 30일이다', async () => {
        const me = new Types.ObjectId();
        for (const n of [0, 29, 30, 89, 90]) await day(me, ago(n), 600);
        expect((await progress.stats(me.toString(), '30d', NOW)).studyDays).toBe(2);
        expect((await progress.stats(me.toString(), '90d', NOW)).studyDays).toBe(4);
        expect((await progress.stats(me.toString(), 'all', NOW)).studyDays).toBe(5);
    });

    it('stats: 서울 자정(UTC 15:00)에 오늘이 바뀌어 잔디 마지막 날과 30d 범위가 하루 밀린다', async () => {
        const me = new Types.ObjectId();
        await day(me, '2026-11-01', 600);
        const before = await progress.stats(me.toString(), '30d', new Date('2026-11-30T14:59:59.000Z'));
        expect(before.heatmap[125]?.studyDate).toBe('2026-11-30');
        expect(before.studyDays).toBe(1); // 11-01은 30d(11-01 ~ 11-30)의 첫날

        const after = await progress.stats(me.toString(), '30d', new Date('2026-11-30T15:00:00.000Z'));
        expect(after.heatmap[125]?.studyDate).toBe('2026-12-01');
        expect(after.studyDays).toBe(0); // 12-01 기준 30d는 11-02부터
    });

    it('stats peakHour: 어뷰징 세션은 빠지고 서울 시각으로 센다, 다른 사람 세션은 섞이지 않는다', async () => {
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        await endedSession(me, new Date('2026-11-10T14:30:00.000Z'), 600); // 서울 23시
        await endedSession(me, new Date('2026-11-09T01:00:00.000Z'), 99999, true); // 서울 10시, 어뷰징: 제외
        await endedSession(other, new Date('2026-11-09T05:00:00.000Z'), 99999); // 다른 사람
        expect((await progress.stats(me.toString(), 'all', NOW)).peakHour).toBe(23);
    });

    it('stats peakHour: session 모듈이 24시간 이상 세션을 정산하면 어뷰징으로 표시되어 peakHour에 들어가지 않는다', async () => {
        const me = new Types.ObjectId();
        await col('users').insertOne({ _id: me, pointBalance: 0, nickname: me.toString() });
        const sessionId = new Types.ObjectId();
        await col('study_sessions').insertOne({
            _id: sessionId,
            userId: me,
            studyDate: '2026-11-09',
            studyItemId: null,
            roomId: null,
            mode: 'personal',
            status: 'running',
            startedAt: new Date('2026-11-09T06:00:00.000Z'), // 서울 15시
            endedAt: null,
            durationSec: 0,
            departureCount: 0,
            endReason: null,
            isAbuse: false,
            pointsEarned: 0,
            pauses: [],
        });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z')); // 30시간 뒤
        try {
            await study.end(me.toString(), sessionId.toString(), { clientDurationSec: 0, endReason: 'user' });
        } finally {
            vi.useRealTimers();
        }
        expect(await col('study_sessions').findOne({ _id: sessionId })).toMatchObject({ isAbuse: true, status: 'ended' });

        const stats = await progress.stats(me.toString(), 'all', NOW);
        expect(stats).toMatchObject({ peakHour: -1, totalSec: 0 });
    });

    // ── 연속 학습일 (FR-09-08, 09-09) ──

    it('streakDays: 오늘 10분 이상이면 오늘까지, 하루 건너뛰면 끊긴다', async () => {
        const me = new Types.ObjectId();
        for (const n of [0, 1, 2]) await day(me, ago(n), 600);
        await day(me, ago(4), 5000); // 3일 전을 건너뛰어서 끊긴다
        expect(await progress.streakDays(me.toString(), NOW)).toBe(3);
    });

    it('streakDays: 오늘 10분 미만이면 어제까지의 연속을 센다', async () => {
        const me = new Types.ObjectId();
        await day(me, ago(0), 599);
        for (const n of [1, 2]) await day(me, ago(n), 700);
        expect(await progress.streakDays(me.toString(), NOW)).toBe(2);
    });

    it('streakDays: 어제도 오늘도 10분 미만이면 0, 기록이 없어도 0이다', async () => {
        const me = new Types.ObjectId();
        await day(me, ago(1), 599);
        await day(me, ago(2), 5000);
        expect(await progress.streakDays(me.toString(), NOW)).toBe(0);
        expect(await progress.streakDays(new Types.ObjectId().toString(), NOW)).toBe(0);
    });

    it('streakDays: 서울 자정(UTC 15:00)이 지나면 오늘이 바뀌어 어제 하루만 있던 연속은 끊긴다', async () => {
        const me = new Types.ObjectId();
        await day(me, '2026-11-29', 600);
        expect(await progress.streakDays(me.toString(), new Date('2026-11-30T14:59:59.000Z'))).toBe(1); // 11-30 아침, 어제까지
        await day(me, '2026-11-30', 600);
        expect(await progress.streakDays(me.toString(), new Date('2026-11-30T14:59:59.000Z'))).toBe(2);
        // 12-01 0시: 오늘(12-01)이 비었으니 어제(11-30)까지 센다 → 2. 하루 더 지나 12-02가 되면 끊긴다
        expect(await progress.streakDays(me.toString(), new Date('2026-11-30T15:00:00.000Z'))).toBe(2);
        expect(await progress.streakDays(me.toString(), new Date('2026-12-01T15:00:00.000Z'))).toBe(0);
    });

    it('streakDays: 다른 사람의 기록은 섞이지 않는다', async () => {
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        for (const n of [0, 1, 2, 3, 4]) await day(other, ago(n), 9000);
        await day(me, ago(0), 600);
        expect(await progress.streakDays(me.toString(), NOW)).toBe(1);
    });

    it('streakDays: 오래된 기록이 많고 중간에 끊겨 있어도 최근 연속만 센다', async () => {
        const me = new Types.ObjectId();
        for (const n of [0, 1, 2]) await day(me, ago(n), 600);
        // 3일 전이 비어 끊긴다. 그 앞 400일은 모두 연속이지만 세지 않는다
        await Promise.all(Array.from({ length: 400 }, (_, i) => day(me, ago(4 + i), 9000)));
        expect(await progress.streakDays(me.toString(), NOW)).toBe(3);
    });

    it('streakDays: 연속이 한 번에 읽는 개수(STREAK_BATCH_SIZE)보다 길어도 정확하다', async () => {
        const me = new Types.ObjectId();
        const run = STREAK_BATCH_SIZE * 3 + 5; // 95일 연속
        await Promise.all(Array.from({ length: run }, (_, n) => day(me, ago(n), 600)));
        await day(me, ago(run + 1), 9000); // 하루 비우고 그 앞은 세지 않는다
        expect(await progress.streakDays(me.toString(), NOW)).toBe(run);
        // 오늘만 빠져도(어제부터 이어짐) 같은 방식으로 센다
        const other = new Types.ObjectId();
        await Promise.all(Array.from({ length: run }, (_, n) => day(other, ago(n + 1), 600)));
        expect(await progress.streakDays(other.toString(), NOW)).toBe(run);
    });

    it('streakDays: 쓰는 쿼리가 (userId, studyDate) 인덱스를 타고 묶음 크기만큼만 읽는다', async () => {
        const me = new Types.ObjectId();
        await Promise.all(Array.from({ length: 200 }, (_, n) => day(me, ago(n), 600)));
        const plan = await col('daily_records')
            .find({ userId: me, studyDate: { $lte: ago(0) } }, { projection: { studyDate: 1, totalSec: 1 } })
            .sort({ studyDate: -1 })
            .limit(STREAK_BATCH_SIZE)
            .explain('executionStats');
        const stats = plan.executionStats as { totalDocsExamined: number; nReturned: number };
        expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
        expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
        expect(stats.nReturned).toBe(STREAK_BATCH_SIZE);
        expect(stats.totalDocsExamined).toBeLessThanOrEqual(STREAK_BATCH_SIZE);
    });

    it('GET /users/me 에 쓰는 UsersService.getMe가 streakDays를 실제 값으로 돌려준다', async () => {
        const me = new Types.ObjectId();
        await col('users').insertOne({ _id: me, nickname: `streak-${me.toString()}`, deletedAt: null, pointBalance: 0 });
        // UsersService는 현재 시각(오늘)을 쓰므로, 시각을 NOW로 고정하고 읽는다
        for (const n of [0, 1, 2, 3]) await day(me, ago(n), 600);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        try {
            expect((await users.getMe(me.toString())).streakDays).toBe(4);
        } finally {
            vi.useRealTimers();
        }
        // 기록이 없는 사용자는 0
        const empty = new Types.ObjectId();
        await col('users').insertOne({ _id: empty, nickname: `streak-${empty.toString()}`, deletedAt: null, pointBalance: 0 });
        expect((await users.getMe(empty.toString())).streakDays).toBe(0);
    });
});
