import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgressTestApp } from './progress-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

// 서울 목요일 정오. 오늘은 2026-11-12
const NOW = new Date('2026-11-12T03:00:00.000Z');

type Day = { studyDate: string; totalSec: number };
type Sess = { studyDate: string; startedAt: Date; durationSec: number; isAbuse: boolean };

let days: Day[];
let sessions: Sess[];

const dailyModel = {
    find: vi.fn((filter: { studyDate: { $gte: string; $lte: string } }) => ({
        lean: vi.fn(() =>
            Promise.resolve(days.filter((d) => d.studyDate >= filter.studyDate.$gte && d.studyDate <= filter.studyDate.$lte)),
        ),
    })),
};
const sessionModel = {
    find: vi.fn((filter: { studyDate?: { $gte: string }; status: string; isAbuse: { $ne: boolean } }) => ({
        lean: vi.fn(() =>
            Promise.resolve(
                sessions.filter((s) => !s.isAbuse && (filter.studyDate === undefined || s.studyDate >= filter.studyDate.$gte)),
            ),
        ),
    })),
};
const weeklyGoalModel = {};

// 할 일 모델의 가짜: distinct만 쓴다. 조건(내 것, 그 달 범위, D-day 짝 제외)에 맞는 dueDate를 중복 없이 돌려준다
let todos: { userId: string; dueDate: string; isDday: boolean; done?: boolean }[];
type TodoFilter = { userId: { toString(): string }; dueDate: { $gte: string; $lte: string }; isDday: boolean };
const todoModel = {
    distinct: vi.fn((_field: string, f: TodoFilter) =>
        Promise.resolve([
            ...new Set(
                todos
                    .filter((t) => t.userId === f.userId.toString() && t.isDday === f.isDday && t.dueDate >= f.dueDate.$gte && t.dueDate <= f.dueDate.$lte)
                    .map((t) => t.dueDate),
            ),
        ]),
    ),
};

// 오늘에서 n일 전 날짜 (2026-11-12 기준)
const ago = (n: number): string => new Date(Date.UTC(2026, 10, 12 - n)).toISOString().slice(0, 10);

describe('GET /study/month', () => {
    let app: INestApplication;
    beforeAll(async () => {
        app = await createProgressTestApp({ dailyRecord: dailyModel, weeklyGoal: weeklyGoalModel, studySession: sessionModel, todo: todoModel });
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(() => {
        days = [];
        sessions = [];
        todos = [];
        todoModel.distinct.mockClear();
    });

    const month = (ym: string) => request(app.getHttpServer()).get('/api/v1/study/month').query({ ym }).set(AUTH);

    it('로그인 없이는 401', async () => {
        await request(app.getHttpServer()).get('/api/v1/study/month').query({ ym: '2026-11' }).expect(401);
    });

    it.each([
        ['2026-02', 28],
        ['2028-02', 29], // 윤년
        ['2026-04', 30],
        ['2026-11', 30],
        ['2026-12', 31],
        ['2026-01', 31],
    ])('%s 달은 %i일이고 1일부터 끝날까지 하루도 빠지지 않는다', async (ym, length) => {
        const res = await month(ym).expect(200);
        const list = res.body.data as { studyDate: string }[];
        expect(list).toHaveLength(length);
        expect(list[0]?.studyDate).toBe(`${ym}-01`);
        expect(list[length - 1]?.studyDate).toBe(`${ym}-${String(length).padStart(2, '0')}`);
        expect(new Set(list.map((d) => d.studyDate)).size).toBe(length);
    });

    it('level은 하루 순공 시간으로 정하고 할 일이 없으면 hasTodo는 false다', async () => {
        days = [
            { studyDate: '2026-11-01', totalSec: 1 },
            { studyDate: '2026-11-02', totalSec: 30 * 60 },
            { studyDate: '2026-11-03', totalSec: 60 * 60 },
            { studyDate: '2026-11-04', totalSec: 2 * 3600 },
            { studyDate: '2026-10-31', totalSec: 99999 }, // 다른 달
            { studyDate: '2026-12-01', totalSec: 99999 }, // 다른 달
        ];
        const res = await month('2026-11').expect(200);
        const list = res.body.data as { level: number; hasTodo: boolean }[];
        expect(list.slice(0, 5).map((d) => d.level)).toEqual([1, 2, 3, 4, 0]);
        expect(list.every((d) => d.hasTodo === false)).toBe(true);
    });

    it('할 일이 있는 날만 hasTodo가 true다 (같은 날 여러 개 · 완료한 것 포함, D-day 짝 · 남의 것 · 다른 달은 제외)', async () => {
        const me = TEST_USER_ID;
        const other = new Types.ObjectId().toString();
        todos = [
            { userId: me, dueDate: '2026-11-05', isDday: false },
            { userId: me, dueDate: '2026-11-05', isDday: false }, // 같은 날 두 개
            { userId: me, dueDate: '2026-11-20', isDday: false, done: true }, // 완료한 할 일도 센다
            { userId: me, dueDate: '2026-11-20', isDday: true }, // 과제 · 시험의 D-day 짝
            { userId: me, dueDate: '2026-11-25', isDday: true }, // 직접 만든 D-day만 있는 날
            { userId: me, dueDate: '2026-10-31', isDday: false }, // 이전 달
            { userId: me, dueDate: '2026-12-01', isDday: false }, // 다음 달
            { userId: other, dueDate: '2026-11-10', isDday: false }, // 다른 사람
        ];
        const res = await month('2026-11').expect(200);
        const list = res.body.data as { studyDate: string; hasTodo: boolean }[];
        expect(list).toHaveLength(30);
        expect(list.filter((d) => d.hasTodo).map((d) => d.studyDate)).toEqual(['2026-11-05', '2026-11-20']);
    });

    it('그 달 할 일 날짜는 날짜마다가 아니라 한 번의 조회로 가져온다', async () => {
        const me = TEST_USER_ID;
        todos = [{ userId: me, dueDate: '2026-02-14', isDday: false }];
        const res = await month('2026-02').expect(200);
        expect(res.body.data).toHaveLength(28);
        expect(todoModel.distinct).toHaveBeenCalledTimes(1);
        const [field, filter] = todoModel.distinct.mock.calls[0] as [string, TodoFilter];
        expect(field).toBe('dueDate');
        expect(filter).toMatchObject({ dueDate: { $gte: '2026-02-01', $lte: '2026-02-28' }, isDday: false });
        expect(filter.userId.toString()).toBe(me);
    });

    it.each(['2026-13', '2026-00', '2026-1', '202611', 'abc', '2026-11-01'])('ym=%s 는 400', async (ym) => {
        await month(ym).expect(400);
    });

    it('ym이 없으면 400', async () => {
        await request(app.getHttpServer()).get('/api/v1/study/month').set(AUTH).expect(400);
    });
});

describe('GET /study/stats', () => {
    let app: INestApplication;
    beforeAll(async () => {
        app = await createProgressTestApp({ dailyRecord: dailyModel, weeklyGoal: weeklyGoalModel, studySession: sessionModel });
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        days = [];
        sessions = [];
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const stats = (range?: string) =>
        request(app.getHttpServer()).get('/api/v1/study/stats').query(range === undefined ? {} : { range }).set(AUTH);

    it('로그인 없이는 401', async () => {
        await request(app.getHttpServer()).get('/api/v1/study/stats').query({ range: 'all' }).expect(401);
    });

    it.each(['week', '7d', '', 'ALL'])('range=%s 는 400', async (range) => {
        await stats(range).expect(400);
    });

    it('range가 없으면 400', async () => {
        await stats().expect(400);
    });

    it('기록이 없으면 0 · peakHour -1 · 잔디 126일은 모두 level 0이고 오늘로 끝난다', async () => {
        const res = await stats('all').expect(200);
        expect(res.body.data).toMatchObject({ totalSec: 0, studyDays: 0, longestStreak: 0, peakHour: -1 });
        const heat = res.body.data.heatmap as { studyDate: string; level: number }[];
        expect(heat).toHaveLength(126);
        expect(heat[125]?.studyDate).toBe('2026-11-12');
        expect(heat[0]?.studyDate).toBe(ago(125));
        expect(heat.every((h) => h.level === 0)).toBe(true);
    });

    it('90d는 오늘 포함 90일(오늘-89일부터), 30d는 오늘 포함 30일(오늘-29일부터)이다', async () => {
        days = [
            { studyDate: ago(0), totalSec: 600 },
            { studyDate: ago(29), totalSec: 600 }, // 30d 첫날 → 포함
            { studyDate: ago(30), totalSec: 600 }, // 30d 밖
            { studyDate: ago(89), totalSec: 600 }, // 90d 첫날 → 포함
            { studyDate: ago(90), totalSec: 600 }, // 90d 밖
        ];
        expect((await stats('30d').expect(200)).body.data).toMatchObject({ totalSec: 1200, studyDays: 2 });
        expect((await stats('90d').expect(200)).body.data).toMatchObject({ totalSec: 2400, studyDays: 4 });
        expect((await stats('all').expect(200)).body.data).toMatchObject({ totalSec: 3000, studyDays: 5 });
    });

    it('range마다 합계 · 공부한 날 · 최장 연속이 달라진다', async () => {
        // 오래전 5일 연속(all만), 60일 전 3일 연속(90d부터), 최근 2일 연속(모두)
        days = [
            ...[100, 101, 102, 103, 104].map((n) => ({ studyDate: ago(n), totalSec: 1000 })),
            ...[60, 61, 62].map((n) => ({ studyDate: ago(n), totalSec: 2000 })),
            ...[0, 1].map((n) => ({ studyDate: ago(n), totalSec: 3000 })),
        ];
        const d30 = (await stats('30d').expect(200)).body.data;
        const d90 = (await stats('90d').expect(200)).body.data;
        const all = (await stats('all').expect(200)).body.data;
        expect([d30.totalSec, d90.totalSec, all.totalSec]).toEqual([6000, 12000, 17000]);
        expect([d30.studyDays, d90.studyDays, all.studyDays]).toEqual([2, 5, 10]);
        expect([d30.longestStreak, d90.longestStreak, all.longestStreak]).toEqual([2, 3, 5]);
    });

    it('10분 미만인 날은 합계에는 들어가지만 공부한 날 · 연속에는 들어가지 않는다', async () => {
        days = [
            { studyDate: ago(2), totalSec: 600 },
            { studyDate: ago(1), totalSec: 599 },
            { studyDate: ago(0), totalSec: 600 },
        ];
        expect((await stats('30d').expect(200)).body.data).toMatchObject({ totalSec: 1799, studyDays: 2, longestStreak: 1 });
    });

    it('heatmap은 range와 상관없이 최근 126일 level이다', async () => {
        days = [{ studyDate: ago(100), totalSec: 3600 }]; // 30d 밖이지만 잔디에는 보인다
        const res = await stats('30d').expect(200);
        const heat = res.body.data.heatmap as { studyDate: string; level: number }[];
        expect(res.body.data.totalSec).toBe(0);
        expect(heat.find((h) => h.studyDate === ago(100))?.level).toBe(3);
    });

    it('peakHour: 어뷰징 세션은 빠지고, 서울 시각으로 센다', async () => {
        sessions = [
            { studyDate: ago(1), startedAt: new Date('2026-11-10T14:30:00Z'), durationSec: 600, isAbuse: false }, // 서울 23시
            { studyDate: ago(2), startedAt: new Date('2026-11-09T01:00:00Z'), durationSec: 99999, isAbuse: true }, // 어뷰징: 제외
        ];
        expect((await stats('all').expect(200)).body.data.peakHour).toBe(23);
    });

    it('서울 자정을 지나면 오늘이 바뀐다 (UTC 14:59:59 → 11월 30일, 15:00:00 → 12월 1일)', async () => {
        vi.setSystemTime(new Date('2026-11-30T14:59:59.000Z'));
        const before = (await stats('all').expect(200)).body.data.heatmap as { studyDate: string }[];
        expect(before[125]?.studyDate).toBe('2026-11-30');
        vi.setSystemTime(new Date('2026-11-30T15:00:00.000Z'));
        const after = (await stats('all').expect(200)).body.data.heatmap as { studyDate: string }[];
        expect(after[125]?.studyDate).toBe('2026-12-01');
    });
});
