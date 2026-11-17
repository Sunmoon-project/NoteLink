// 연속 학습일(streakDays)이 최근 기록부터 일정 개수씩만 읽다가 첫 공백에서 멈추는지 확인한다 (FR-09-09).
// DB 대신 메모리 가짜 모델을 쓰고, 실제로 몇 건을 읽었는지(readCount)까지 센다.
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProgressService, STREAK_BATCH_SIZE } from '../src/modules/progress/progress.service.js';
import { currentStreak } from '../src/modules/progress/stats.js';

// 서울 목요일 정오. 오늘은 2026-11-12
const NOW = new Date('2026-11-12T03:00:00.000Z');
const ago = (n: number): string => new Date(Date.UTC(2026, 10, 12 - n)).toISOString().slice(0, 10);

type Day = { userId: string; studyDate: string; totalSec: number };
type Filter = { userId: Types.ObjectId; studyDate: { $lte?: string; $lt?: string } };

let days: Day[];
let readCount: number; // DB에서 읽어 간 문서 수
let queries: { filter: Filter; limit: number; sort: Record<string, number> }[];

const dailyModel = {
    find: vi.fn((filter: Filter) => {
        const query = { filter, limit: Infinity, sort: {} as Record<string, number> };
        queries.push(query);
        const chain = {
            sort: (sort: Record<string, number>) => {
                query.sort = sort;
                return chain;
            },
            limit: (n: number) => {
                query.limit = n;
                return chain;
            },
            lean: () => {
                const { $lte, $lt } = filter.studyDate;
                const found = days
                    .filter((d) => d.userId === filter.userId.toString())
                    .filter((d) => ($lte === undefined || d.studyDate <= $lte) && ($lt === undefined || d.studyDate < $lt))
                    .sort((a, b) => (a.studyDate < b.studyDate ? 1 : -1)) // 내림차순
                    .slice(0, query.limit)
                    .map(({ studyDate, totalSec }) => ({ studyDate, totalSec }));
                readCount += found.length;
                return Promise.resolve(found);
            },
        };
        return chain;
    }),
};

const service = new ProgressService(dailyModel as never, {} as never, {} as never, {} as never);
const me = new Types.ObjectId();
const add = (n: number, totalSec: number, userId = me.toString()): void => {
    days.push({ userId, studyDate: ago(n), totalSec });
};

beforeEach(() => {
    days = [];
    readCount = 0;
    queries = [];
    dailyModel.find.mockClear();
});

describe('streakDays: 최근 기록부터 읽다가 끊기면 멈춤', () => {
    it('오래된 기록이 많고 중간에 끊겨 있어도 최근 연속만 센다 (오래된 기록은 읽지 않는다)', async () => {
        for (const n of [0, 1, 2]) add(n, 600); // 최근 3일 연속
        // 3일 전이 비어서 끊긴다. 그보다 오래된 기록 500일치는 연속이지만 세면 안 된다
        for (let n = 4; n < 504; n++) add(n, 9000);

        expect(await service.streakDays(me.toString(), NOW)).toBe(3);
        expect(readCount).toBeLessThanOrEqual(STREAK_BATCH_SIZE); // 한 묶음만 읽고 끝
        expect(queries).toHaveLength(1);
    });

    it('10분 미만인 날에서 끊기고, 그 뒤의 오래된 기록은 읽지 않는다', async () => {
        add(0, 600);
        add(1, 600);
        add(2, 599); // 10분 미만 → 끊긴다
        for (let n = 3; n < 200; n++) add(n, 9000);

        expect(await service.streakDays(me.toString(), NOW)).toBe(2);
        expect(queries).toHaveLength(1);
        expect(readCount).toBeLessThanOrEqual(STREAK_BATCH_SIZE);
    });

    it('연속이 한 번에 읽는 개수보다 길어도 정확히 센다 (여러 묶음을 이어서 읽는다)', async () => {
        const run = STREAK_BATCH_SIZE * 2 + 7; // 67일 연속 (오늘 포함)
        for (let n = 0; n < run; n++) add(n, 600);
        add(run, 0); // 연속 바로 앞날은 공부 안 함
        for (let n = run + 1; n < run + 100; n++) add(n, 9000);

        expect(await service.streakDays(me.toString(), NOW)).toBe(run);
        expect(queries.length).toBe(Math.ceil((run + 1) / STREAK_BATCH_SIZE)); // 끊긴 날이 있는 묶음까지만
        expect(readCount).toBeLessThanOrEqual(queries.length * STREAK_BATCH_SIZE);
        expect(readCount).toBeLessThan(days.length); // 전부 읽지 않았다
    });

    it('연속의 끝이 묶음 경계에 딱 맞아도 정확하다 (기록이 거기서 끝나는 경우 포함)', async () => {
        for (let n = 0; n < STREAK_BATCH_SIZE; n++) add(n, 600);
        expect(await service.streakDays(me.toString(), NOW)).toBe(STREAK_BATCH_SIZE);

        // 경계 바로 다음 날이 비어 있는 경우
        days = [];
        for (let n = 0; n < STREAK_BATCH_SIZE; n++) add(n, 600);
        add(STREAK_BATCH_SIZE + 1, 600);
        expect(await service.streakDays(me.toString(), NOW)).toBe(STREAK_BATCH_SIZE);
    });

    it('묶음 크기를 아주 작게 해도(1건씩) 결과가 같다', async () => {
        for (const n of [0, 1, 2, 3]) add(n, 600);
        add(5, 600);
        expect(await service.streakDays(me.toString(), NOW, 1)).toBe(4);
        expect(await service.streakDays(me.toString(), NOW, 2)).toBe(4);
    });

    it('최근 날짜 내림차순으로, 오늘까지만(오늘 이하) 읽고 (userId, studyDate) 인덱스 순서를 쓴다', async () => {
        add(0, 600);
        await service.streakDays(me.toString(), NOW);
        const [query] = queries;
        expect(query?.sort).toEqual({ studyDate: -1 });
        expect(query?.filter.studyDate).toEqual({ $lte: '2026-11-12' });
        expect(query?.limit).toBe(STREAK_BATCH_SIZE);
        expect(query?.filter.userId.toString()).toBe(me.toString());
    });

    // ── 결과가 예전 방식(10분 이상인 날 전체로 currentStreak)과 같은지 ──
    const oldWay = (list: Day[], who: string): number =>
        currentStreak(new Set(list.filter((d) => d.userId === who && d.totalSec >= 600 && d.studyDate <= ago(0)).map((d) => d.studyDate)), ago(0));

    it('오늘 10분 이상 / 오늘 10분 미만 / 오늘 기록 없음 / 어제도 비어 있음이 예전 결과와 같다', async () => {
        const cases: { n: number; sec: number }[][] = [
            [{ n: 0, sec: 600 }, { n: 1, sec: 600 }, { n: 2, sec: 600 }, { n: 4, sec: 9000 }],
            [{ n: 0, sec: 599 }, { n: 1, sec: 700 }, { n: 2, sec: 700 }],
            [{ n: 1, sec: 700 }, { n: 2, sec: 700 }, { n: 3, sec: 700 }],
            [{ n: 0, sec: 0 }, { n: 1, sec: 599 }, { n: 2, sec: 5000 }],
            [{ n: 2, sec: 5000 }],
            [],
        ];
        for (const list of cases) {
            days = list.map(({ n, sec }) => ({ userId: me.toString(), studyDate: ago(n), totalSec: sec }));
            expect(await service.streakDays(me.toString(), NOW)).toBe(oldWay(days, me.toString()));
            expect(await service.streakDays(me.toString(), NOW, 1)).toBe(oldWay(days, me.toString()));
        }
    });

    it('다른 사람의 기록은 섞이지 않는다', async () => {
        const other = new Types.ObjectId().toString();
        for (const n of [0, 1, 2, 3, 4]) add(n, 9000, other);
        add(0, 600);
        expect(await service.streakDays(me.toString(), NOW)).toBe(1);
    });
});
