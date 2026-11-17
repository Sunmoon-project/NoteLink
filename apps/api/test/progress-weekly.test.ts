import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgressTestApp } from './progress-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

const owner = new Types.ObjectId(TEST_USER_ID);

// 서울 목요일 정오. 이번 주 월요일은 2026-11-09, 지난주 월요일은 2026-11-02
const NOW = new Date('2026-11-12T03:00:00.000Z');
const WEEK = '2026-11-09';

let days: { studyDate: string; totalSec: number }[];
let goals: Record<string, unknown>[];

const dailyModel = {
    find: vi.fn((filter: { studyDate: { $gte: string; $lte: string } }) => ({
        lean: vi.fn(() =>
            Promise.resolve(days.filter((d) => d.studyDate >= filter.studyDate.$gte && d.studyDate <= filter.studyDate.$lte)),
        ),
    })),
};
const weeklyGoalModel = {
    findOne: vi.fn((filter: { weekStart: string | { $lt: string } }) => {
        const match = goals.filter((g) =>
            typeof filter.weekStart === 'string'
                ? g.weekStart === filter.weekStart
                : (g.weekStart as string) < filter.weekStart.$lt,
        );
        return {
            lean: () => Promise.resolve(match[0] ?? null),
            sort: () => ({ lean: () => Promise.resolve(match[0] ?? null) }),
        };
    }),
};

describe('GET /study/weekly', () => {
    let app: INestApplication;
    beforeAll(async () => {
        app = await createProgressTestApp({ dailyRecord: dailyModel, weeklyGoal: weeklyGoalModel });
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        days = [];
        goals = [];
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('로그인 없이는 401', async () => {
        await request(app.getHttpServer()).get('/api/v1/study/weekly').expect(401);
    });

    it('기록도 목표도 없으면 0과 7일치 빈 요일을 돌려준다', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/study/weekly').set(AUTH).expect(200);
        expect(res.body.data).toEqual({
            weekStart: WEEK,
            totalSec: 0,
            diffFromLastWeekSec: 0,
            goalMin: 0,
            days: [
                { studyDate: '2026-11-09', totalSec: 0 },
                { studyDate: '2026-11-10', totalSec: 0 },
                { studyDate: '2026-11-11', totalSec: 0 },
                { studyDate: '2026-11-12', totalSec: 0 },
                { studyDate: '2026-11-13', totalSec: 0 },
                { studyDate: '2026-11-14', totalSec: 0 },
                { studyDate: '2026-11-15', totalSec: 0 },
            ],
        });
    });

    it('diffFromLastWeekSec는 지난주 전체가 아니라 지난주 같은 요일(월~목)까지와 비교한다', async () => {
        days = [
            { studyDate: '2026-11-09', totalSec: 100 },
            { studyDate: '2026-11-10', totalSec: 200 },
            { studyDate: '2026-11-11', totalSec: 300 },
            { studyDate: '2026-11-02', totalSec: 50 },
            { studyDate: '2026-11-03', totalSec: 50 },
            { studyDate: '2026-11-04', totalSec: 50 },
            { studyDate: '2026-11-05', totalSec: 10 }, // 지난주 목요일 (같은 요일까지에 포함)
            { studyDate: '2026-11-06', totalSec: 9999 }, // 지난주 금요일: 비교에서 빠진다
            { studyDate: '2026-11-08', totalSec: 5000 }, // 지난주 일요일: 비교에서 빠진다
        ];
        goals = [{ _id: new Types.ObjectId(), userId: owner, weekStart: WEEK, targetMin: 840, notify80: true }];

        const res = await request(app.getHttpServer()).get('/api/v1/study/weekly').set(AUTH).expect(200);
        expect(res.body.data).toMatchObject({
            weekStart: WEEK,
            totalSec: 600,
            diffFromLastWeekSec: 600 - 160, // 이번 주 월~목 600초 − 지난주 월~목 160초
            goalMin: 840,
        });
        expect(res.body.data.days.map((d: { totalSec: number }) => d.totalSec)).toEqual([100, 200, 300, 0, 0, 0, 0]);
    });

    it('이번 주보다 덜 했으면 diff가 음수다', async () => {
        days = [{ studyDate: '2026-11-03', totalSec: 700 }];
        const res = await request(app.getHttpServer()).get('/api/v1/study/weekly').set(AUTH).expect(200);
        expect(res.body.data.diffFromLastWeekSec).toBe(-700);
    });

    it('월요일이면 지난주 월요일 하루와만 비교한다', async () => {
        vi.setSystemTime(new Date('2026-11-15T15:00:00.000Z')); // 서울 월요일 00:00 (2026-11-16)
        days = [
            { studyDate: '2026-11-16', totalSec: 30 },
            { studyDate: '2026-11-09', totalSec: 10 },
            { studyDate: '2026-11-10', totalSec: 9999 },
        ];
        const res = await request(app.getHttpServer()).get('/api/v1/study/weekly').set(AUTH).expect(200);
        expect(res.body.data).toMatchObject({ weekStart: '2026-11-16', totalSec: 30, diffFromLastWeekSec: 20 });
    });
});
