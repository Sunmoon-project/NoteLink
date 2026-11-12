// 진짜 MongoDB(replica set)에서 이번 주 목표(FR-06-24)를 확인하는 테스트.
// 확인하는 것: 목표 없을 때 응답, 같은 주 PUT 두 번(동시 포함)이면 한 건만 남음, 최근 4주 평균, 다른 사람 기록이 섞이지 않음.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일·실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/progress-weekly-real-db.test.ts
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProgressService } from '../src/modules/progress/progress.service.js';
import { DailyRecord, DailyRecordSchema } from '../src/modules/progress/schemas/daily-record.schema.js';
import { WeeklyGoal, WeeklyGoalSchema } from '../src/modules/progress/schemas/weekly-goal.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_progress_weekly_${process.pid}_${Date.now()}`;

// 서울 목요일 정오. 이번 주 월요일은 2026-11-09
const NOW = new Date('2026-11-12T03:00:00.000Z');
const WEEK = '2026-11-09';

describe.skipIf(!isLocal)('진짜 DB 이번 주 목표 · 요약 확인', () => {
    let moduleRef: TestingModule;
    let conn: Connection;
    let progress: ProgressService;
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

    beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: DailyRecord.name, schema: DailyRecordSchema },
                    { name: WeeklyGoal.name, schema: WeeklyGoalSchema },
                ]),
            ],
            providers: [ProgressService],
        }).compile();
        await moduleRef.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        // unique 인덱스가 확실히 만들어지게 한다
        await conn.model(WeeklyGoal.name).syncIndexes();
        await conn.model(DailyRecord.name).syncIndexes();
        progress = moduleRef.get(ProgressService);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await moduleRef?.close();
    });

    it('weekly_goals에 (userId, weekStart) unique 인덱스가 있다', async () => {
        const indexes = await col('weekly_goals').indexes();
        expect(indexes).toContainEqual(expect.objectContaining({ key: { userId: 1, weekStart: 1 }, unique: true }));
    });

    it('목표가 없으면 targetMin 0 · notify80 true · recentAvgMin 0이고 DB에는 아무것도 만들지 않는다', async () => {
        const userId = new Types.ObjectId();
        const goal = await progress.getWeeklyGoal(userId.toString(), NOW);
        expect(goal).toEqual({ _id: `wg-${WEEK}`, weekStart: WEEK, targetMin: 0, notify80: true, recentAvgMin: 0 });
        expect(await col('weekly_goals').countDocuments({ userId })).toBe(0);
    });

    it('PUT 한 번이면 저장되고, 같은 주에 한 번 더 하면 같은 한 건이 바뀐다', async () => {
        const userId = new Types.ObjectId();
        const first = await progress.setWeeklyGoal(userId.toString(), { targetMin: 600, notify80: true }, NOW);
        const second = await progress.setWeeklyGoal(userId.toString(), { targetMin: 840, notify80: false }, NOW);

        expect(second._id).toBe(first._id);
        expect(second).toMatchObject({ weekStart: WEEK, targetMin: 840, notify80: false });
        const rows = await col('weekly_goals').find({ userId }).toArray();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ weekStart: WEEK, targetMin: 840, notify80: false });
        expect(rows[0]!.userId).toBeInstanceOf(Types.ObjectId); // 문자열이 아니라 ObjectId로 저장된다
        expect(await progress.getWeeklyGoal(userId.toString(), NOW)).toMatchObject({ targetMin: 840, notify80: false });
    });

    it('같은 주 PUT이 동시에 여러 번 와도 한 건만 남는다', async () => {
        const userId = new Types.ObjectId();
        const results = await Promise.allSettled(
            Array.from({ length: 8 }, (_, i) =>
                progress.setWeeklyGoal(userId.toString(), { targetMin: 60 * (i + 1), notify80: i % 2 === 0 }, NOW),
            ),
        );
        expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
        expect(await col('weekly_goals').countDocuments({ userId, weekStart: WEEK })).toBe(1);
    });

    it('다른 주에는 따로 저장되고, 새 주에 정하기 전에는 지난 목표를 이어받는다', async () => {
        const userId = new Types.ObjectId();
        await progress.setWeeklyGoal(userId.toString(), { targetMin: 600, notify80: false }, NOW);
        const nextWeek = new Date('2026-11-15T15:00:00.000Z'); // 서울 월요일 00:00 (새 주)

        const before = await progress.getWeeklyGoal(userId.toString(), nextWeek);
        expect(before).toMatchObject({ weekStart: '2026-11-16', targetMin: 600, notify80: false, _id: 'wg-2026-11-16' });

        await progress.setWeeklyGoal(userId.toString(), { targetMin: 900, notify80: true }, nextWeek);
        expect(await col('weekly_goals').countDocuments({ userId })).toBe(2);
        expect(await progress.getWeeklyGoal(userId.toString(), NOW)).toMatchObject({ targetMin: 600 }); // 지난주 목표는 그대로
    });

    it('recentAvgMin은 이번 주를 빼고 최근 4주 평균이고, 다른 사람 기록은 섞이지 않는다', async () => {
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        await day(me, '2026-11-10', 99999); // 이번 주: 빠진다
        await day(me, '2026-11-03', 4 * 3600);
        await day(me, '2026-10-27', 4 * 3600);
        await day(me, '2026-10-20', 4 * 3600);
        await day(me, '2026-10-14', 4 * 3600);
        await day(me, '2026-10-11', 99999); // 5주 전: 빠진다
        await day(other, '2026-11-03', 100 * 3600); // 다른 사람
        await day(other, '2026-10-27', 100 * 3600);

        expect((await progress.getWeeklyGoal(me.toString(), NOW)).recentAvgMin).toBe(240);
        expect((await progress.getWeeklyGoal(new Types.ObjectId().toString(), NOW)).recentAvgMin).toBe(0);
    });

    it('다른 사람의 목표가 내 목표로 보이지 않는다', async () => {
        const me = new Types.ObjectId();
        const other = new Types.ObjectId();
        await progress.setWeeklyGoal(other.toString(), { targetMin: 1200, notify80: false }, NOW);
        expect(await progress.getWeeklyGoal(me.toString(), NOW)).toMatchObject({ targetMin: 0, notify80: true });
    });
});
