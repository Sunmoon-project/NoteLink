import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgressTestApp } from './progress-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

const owner = new Types.ObjectId(TEST_USER_ID);

// 서울 목요일 정오. 이번 주 월요일은 2026-11-09
const NOW = new Date('2026-11-12T03:00:00.000Z');
const WEEK = '2026-11-09';

type Update = { filter: Record<string, unknown>; update: { $set: Record<string, unknown> }; options: Record<string, unknown> };

let days: { studyDate: string; totalSec: number }[];
let goals: Record<string, unknown>[];
let lastUpdate: Update | undefined;

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
        const sorted = [...match].sort((a, b) => (b.weekStart as string).localeCompare(a.weekStart as string));
        return {
            lean: () => Promise.resolve(match[0] ?? null),
            sort: () => ({ lean: () => Promise.resolve(sorted[0] ?? null) }),
        };
    }),
    findOneAndUpdate: vi.fn((filter: Record<string, unknown>, update: { $set: Record<string, unknown> }, options: Record<string, unknown>) => {
        lastUpdate = { filter, update, options };
        const saved = { _id: new Types.ObjectId(), userId: owner, weekStart: filter.weekStart, ...update.$set };
        goals = [saved];
        return { lean: () => Promise.resolve(saved) };
    }),
};

describe('GET·PUT /goals/weekly', () => {
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
        lastUpdate = undefined;
        weeklyGoalModel.findOneAndUpdate.mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('로그인 없이는 401', async () => {
        await request(app.getHttpServer()).get('/api/v1/goals/weekly').expect(401);
        await request(app.getHttpServer()).put('/api/v1/goals/weekly').send({ targetMin: 60, notify80: true }).expect(401);
    });

    it('목표가 없으면 targetMin 0 · notify80 true · recentAvgMin 0', async () => {
        const res = await request(app.getHttpServer()).get('/api/v1/goals/weekly').set(AUTH).expect(200);
        expect(res.body).toEqual({ data: { _id: `wg-${WEEK}`, weekStart: WEEK, targetMin: 0, notify80: true, recentAvgMin: 0 } });
    });

    it('이번 주에 정한 목표가 없으면 가장 최근 목표를 이어받는다', async () => {
        goals = [{ _id: new Types.ObjectId(), userId: owner, weekStart: '2026-11-02', targetMin: 600, notify80: false }];
        const res = await request(app.getHttpServer()).get('/api/v1/goals/weekly').set(AUTH).expect(200);
        expect(res.body.data).toMatchObject({ weekStart: WEEK, targetMin: 600, notify80: false });
    });

    it('recentAvgMin은 이번 주를 빼고 최근 4주의 주간 평균이다', async () => {
        days = [
            { studyDate: '2026-11-10', totalSec: 99999 }, // 이번 주: 빠져야 한다
            { studyDate: '2026-11-03', totalSec: 4 * 3600 }, // 1주 전
            { studyDate: '2026-10-27', totalSec: 4 * 3600 }, // 2주 전
            { studyDate: '2026-10-20', totalSec: 4 * 3600 }, // 3주 전
            { studyDate: '2026-10-14', totalSec: 4 * 3600 }, // 4주 전 (수요일)
            { studyDate: '2026-10-11', totalSec: 99999 }, // 5주 전 일요일: 빠져야 한다
        ];
        const res = await request(app.getHttpServer()).get('/api/v1/goals/weekly').set(AUTH).expect(200);
        expect(res.body.data.recentAvgMin).toBe(240); // (4시간 × 4주) / 4 = 240분
    });

    it('PUT은 이번 주 월요일 기준 upsert 한 번으로 저장하고 새 모양을 돌려준다', async () => {
        const res = await request(app.getHttpServer())
            .put('/api/v1/goals/weekly')
            .set(AUTH)
            .send({ targetMin: 840, notify80: false })
            .expect(200);
        expect(lastUpdate?.filter).toEqual({ userId: owner, weekStart: WEEK });
        expect(lastUpdate?.options).toMatchObject({ upsert: true });
        expect(res.body.data).toMatchObject({ weekStart: WEEK, targetMin: 840, notify80: false, recentAvgMin: 0 });
        expect(res.body.data._id).not.toBe(`wg-${WEEK}`);
    });

    it('targetMin은 0 ~ 10080으로 맞춘다 (앱과 같다)', async () => {
        const high = await request(app.getHttpServer()).put('/api/v1/goals/weekly').set(AUTH).send({ targetMin: 20000, notify80: true }).expect(200);
        expect(high.body.data.targetMin).toBe(10080);
        const low = await request(app.getHttpServer()).put('/api/v1/goals/weekly').set(AUTH).send({ targetMin: -30, notify80: true }).expect(200);
        expect(low.body.data.targetMin).toBe(0);
    });

    it('숫자가 아니거나 notify80이 빠지면 400이고 저장하지 않는다', async () => {
        await request(app.getHttpServer()).put('/api/v1/goals/weekly').set(AUTH).send({ targetMin: '많이', notify80: true }).expect(400);
        await request(app.getHttpServer()).put('/api/v1/goals/weekly').set(AUTH).send({ targetMin: 60 }).expect(400);
        expect(weeklyGoalModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('동시에 둘이 눌러 unique 인덱스에 막히면 이미 만들어진 목표를 바꾼다', async () => {
        weeklyGoalModel.findOneAndUpdate.mockImplementationOnce(() => ({
            lean: () => Promise.reject(Object.assign(new Error('E11000'), { code: 11000 })),
        }));
        const res = await request(app.getHttpServer()).put('/api/v1/goals/weekly').set(AUTH).send({ targetMin: 300, notify80: true }).expect(200);
        expect(res.body.data.targetMin).toBe(300);
        expect(weeklyGoalModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
    });
});
