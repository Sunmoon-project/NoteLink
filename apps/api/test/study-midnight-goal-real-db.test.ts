// 진짜 MongoDB에서 "자정을 넘긴 공부가 다음 날 과목 시간에도 쌓이고, 반복 목표(과목 지정)가 달성으로 판정되는지" 확인하는 테스트 (FR-11-06).
// 실제 세션 시작 → 서울 23:50에서 00:30까지 공부한 뒤 끝내기(StudyService) → 반복 목표 목록의 streak(RecurringGoalsService)까지 이어서 본다.
// 확인하는 것: 다음 날 과목 시간(daily_records.subjectSec)이 쌓이고 과목 목표가 달성으로 판정되는 것, 과목 없는 항목은 쌓지 않는 것,
// 하루 상한(16시간)을 넘는 부분은 쌓지 않는 것, 새 칸이 없는 옛 기록(items만 있음)도 지금처럼 판정되는 것, 앱 응답(GET /study/today 모양)에 새 칸이 나오지 않는 것.
// 시계(Date)만 서울 시각으로 조작하고, 시작 · 끝내기는 진짜 서비스 코드를 그대로 쓴다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/study-midnight-goal-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { HolidaysService } from '../src/modules/calendar/holidays.service.js';
import { RecurringGoalsService } from '../src/modules/progress/recurring-goals.service.js';
import { DailyRecord, DailyRecordSchema } from '../src/modules/progress/schemas/daily-record.schema.js';
import { RecurringGoal, RecurringGoalSchema } from '../src/modules/progress/schemas/recurring-goal.schema.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger, PointLedgerSchema } from '../src/modules/reward/schemas/point-ledger.schema.js';
import { StudySession, StudySessionSchema } from '../src/modules/session/schemas/study-session.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';
import { StudyService } from '../src/modules/session/study.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_midnight_${process.pid}_${Date.now()}`;

// 서울 2026-11-13(금) 23:50 → 2026-11-14(토) 00:30. 금요일 23:50 ~ 토요일 00:30 = 금 10분 + 토 30분
const START = new Date('2026-11-13T14:50:00Z');
const END = new Date('2026-11-13T15:30:00Z');
const FRIDAY = '2026-11-13';
const SATURDAY = '2026-11-14';
const CREATED = new Date('2026-10-01T00:00:00+09:00');

describe.skipIf(!isLocal)('진짜 DB 자정을 넘긴 공부와 과목 반복 목표', () => {
    let moduleRef: TestingModule;
    let conn: Connection;
    let study: StudyService;
    let goals: RecurringGoalsService;
    const col = (name: string) => conn.collection(name);

    type DailyRaw = { totalSec: number; subjectSec?: Record<string, number>; items: { accumulatedSec: number }[] };
    const dailyOf = async (userId: Types.ObjectId, studyDate: string) =>
        (await col('daily_records').findOne({ userId, studyDate })) as unknown as DailyRaw | null;

    /** 사용자 · 금요일 하루 기록(공부 항목 하나, 과목은 있을 수도 없을 수도) · 금요일 · 토요일 반복 목표를 만든다 */
    const setup = async (withSubject = true) => {
        const userId = new Types.ObjectId();
        const itemId = new Types.ObjectId();
        const subjectId = new Types.ObjectId();
        // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
        await col('users').insertOne({ _id: userId, nickname: `midnight_${userId.toString()}`, pointBalance: 0 });
        await col('daily_records').insertOne({
            userId,
            studyDate: FRIDAY,
            totalSec: 0,
            personalSec: 0,
            roomSec: 0,
            streakOk: false,
            items: [
                {
                    _id: itemId,
                    title: '수학 공부',
                    subjectId: withSubject ? subjectId : null,
                    subjectName: withSubject ? '수학' : null,
                    goalMin: null,
                    accumulatedSec: 0,
                },
            ],
        });
        // 과목 목표: 토요일 20분 이상. 자정 뒤 30분을 공부했으니 달성이어야 한다
        const goalId = new Types.ObjectId();
        await col('recurring_goals').insertOne({
            _id: goalId,
            userId,
            name: '수학 토요일',
            days: [6],
            targetMin: 20,
            subjectId,
            remindEnabled: false,
            remindTime: null,
            pausedUntil: null,
            isActive: true,
            deletedAt: null,
            createdAt: CREATED,
            updatedAt: CREATED,
        });
        return { userId, itemId, subjectId, goalId };
    };

    /** 서울 23:50에 세션을 시작하고 00:30에 끝낸다 (시계만 조작) */
    const studyOverMidnight = async (userId: Types.ObjectId, itemId: Types.ObjectId) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START);
        const started = await study.startSession(userId.toString(), { studyItemId: itemId.toString(), mode: 'personal' } as never);
        expect(started).toBeDefined();
        vi.setSystemTime(END);
        const ended = await study.end(userId.toString(), started!._id, { clientDurationSec: 2400, endReason: 'user' } as never);
        return ended!;
    };
    const streakAt = async (userId: Types.ObjectId, now: Date) => (await goals.list(userId.toString(), now))[0]!.streak;

    beforeAll(async () => {
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
                    { name: RecurringGoal.name, schema: RecurringGoalSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            providers: [
                StudyService,
                PointService,
                RecurringGoalsService,
                // 공휴일 · 제외일은 이 테스트와 상관없어서 건너뛸 날이 없는 것으로 둔다
                { provide: HolidaysService, useValue: { skipDates: () => Promise.resolve([]) } },
            ],
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
            conn.model(RecurringGoal.name).init(),
            conn.model(User.name).init(),
        ]);
        study = moduleRef.get(StudyService);
        goals = moduleRef.get(RecurringGoalsService);
    }, 30000);

    afterEach(() => {
        vi.useRealTimers();
    });
    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await moduleRef?.close();
    });

    it('a) 자정을 넘긴 공부는 다음 날 과목 시간에도 쌓이고, 그 날의 과목 목표가 달성으로 판정된다', async () => {
        const { userId, itemId, subjectId } = await setup();
        const ended = await studyOverMidnight(userId, itemId);
        expect(ended.durationSec).toBe(2400); // 40분

        const fri = await dailyOf(userId, FRIDAY);
        const sat = await dailyOf(userId, SATURDAY);
        expect(fri?.totalSec).toBe(600); // 금요일 10분
        expect(sat?.totalSec).toBe(1800); // 토요일 30분
        expect(fri?.subjectSec?.[subjectId.toString()]).toBe(600);
        expect(sat?.subjectSec?.[subjectId.toString()]).toBe(1800); // 고치기 전에는 이 칸이 없어 과목 시간이 0이었다
        expect(fri?.items[0]?.accumulatedSec).toBe(600); // 항목 시간은 지금처럼 시작한 날에만
        expect(sat?.items).toEqual([]);

        // 토요일(30분 ≥ 20분)은 달성. 일요일 정오로 보면 이 주(11-09 주)의 대상 날(토)이 달성이라 이번 주가 센다
        expect(await streakAt(userId, new Date('2026-11-15T03:00:00Z'))).toBe(1);
    });

    it('b) 과목이 없는 항목은 과목 시간을 쌓지 않는다 (총 시간은 쌓는다)', async () => {
        const { userId, itemId } = await setup(false);
        await studyOverMidnight(userId, itemId);
        const sat = await dailyOf(userId, SATURDAY);
        expect(sat?.totalSec).toBe(1800);
        expect(sat?.subjectSec).toBeUndefined();
        expect((await dailyOf(userId, FRIDAY))?.subjectSec).toBeUndefined();
    });

    it('c) 하루 상한(16시간)을 넘는 부분은 과목 시간에도 쌓지 않는다', async () => {
        const { userId, itemId, subjectId } = await setup();
        // 토요일에 이미 15시간 50분 쌓여 있다 → 자정 뒤 30분 중 10분만 센다
        await col('daily_records').insertOne({
            userId,
            studyDate: SATURDAY,
            totalSec: 15 * 3600 + 50 * 60,
            personalSec: 15 * 3600 + 50 * 60,
            roomSec: 0,
            streakOk: true,
            items: [],
        });
        const ended = await studyOverMidnight(userId, itemId);
        expect(ended.durationSec).toBe(1200); // 금요일 10분 + 토요일 상한까지 10분
        const sat = await dailyOf(userId, SATURDAY);
        expect(sat?.totalSec).toBe(16 * 3600);
        expect(sat?.subjectSec?.[subjectId.toString()]).toBe(600);
    });

    it('d) 새 칸이 없는 옛 기록은 지금처럼 항목 시간으로 판정한다', async () => {
        const { userId, subjectId } = await setup();
        // 이 칸이 생기기 전에 쌓인 토요일 기록: subjectSec 없이 항목에만 30분
        await col('daily_records').insertOne({
            userId,
            studyDate: SATURDAY,
            totalSec: 1800,
            personalSec: 1800,
            roomSec: 0,
            streakOk: true,
            items: [{ _id: new Types.ObjectId(), title: '수학', subjectId, subjectName: '수학', goalMin: null, accumulatedSec: 1800 }],
        });
        expect(await streakAt(userId, new Date('2026-11-15T03:00:00Z'))).toBe(1);

        // 항목 시간이 목표(20분)에 못 미치면 옛 기록도 미달성이다
        await col('daily_records').updateOne({ userId, studyDate: SATURDAY }, { $set: { 'items.0.accumulatedSec': 600 } });
        expect(await streakAt(userId, new Date('2026-11-15T03:00:00Z'))).toBe(0);
    });

    it('e) 새 칸이 있으면 항목 시간이 모자라도 새 칸으로 판정한다', async () => {
        const { userId, subjectId } = await setup();
        await col('daily_records').insertOne({
            userId,
            studyDate: SATURDAY,
            totalSec: 1800,
            personalSec: 1800,
            roomSec: 0,
            streakOk: true,
            subjectSec: { [subjectId.toString()]: 1800 },
            items: [], // 자정을 넘긴 몫이라 항목에는 없다
        });
        expect(await streakAt(userId, new Date('2026-11-15T03:00:00Z'))).toBe(1);
    });

    it('f) 앱 응답(GET /study/today 모양)에는 새 칸이 나오지 않는다', async () => {
        const { userId, itemId } = await setup();
        await studyOverMidnight(userId, itemId);
        // 토요일 정오에 오늘 기록을 읽는다 (서울 토요일 기록은 자정 뒤 몫으로 이미 만들어져 있다)
        vi.setSystemTime(new Date('2026-11-14T03:00:00Z'));
        const today = await study.today(userId.toString());
        expect(today.studyDate).toBe(SATURDAY);
        expect(today.totalSec).toBe(1800);
        expect(Object.keys(today).sort()).toEqual(['_id', 'items', 'personalSec', 'roomSec', 'streakOk', 'studyDate', 'totalSec']);
    });
});
