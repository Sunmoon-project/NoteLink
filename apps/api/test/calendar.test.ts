import type { INestApplication } from '@nestjs/common';
import { DDay, Todo } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCalendarTestApp } from './calendar-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

// 서울 일요일 정오 = 2026-11-08
const NOW = new Date('2026-11-08T03:00:00.000Z');

type Row = Record<string, unknown> & { _id: Types.ObjectId; userId: Types.ObjectId; createdAt: Date };
let rows: Row[];
let subjects: { _id: Types.ObjectId; name: string; isActive: boolean }[];
let clock: number;

// 조건의 각 항목이 문서와 같은지만 본다 (id · 날짜 · 불리언은 글자로 비교)
const matches = (row: Row, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, want]) => String(row[key]) === String(want));

const todoModel = {
    find: vi.fn((filter: Record<string, unknown>) => {
        const found = rows.filter((r) => matches(r, filter));
        const chain = {
            sort: vi.fn(() => {
                found.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
                return chain;
            }),
            lean: vi.fn(() => Promise.resolve(found)),
        };
        return chain;
    }),
    findOne: vi.fn((filter: Record<string, unknown>) => ({
        lean: vi.fn(() => Promise.resolve(rows.find((r) => matches(r, filter)) ?? null)),
    })),
    create: vi.fn((docs: Record<string, unknown>[]) =>
        Promise.resolve(
            docs.map((doc) => {
                const row = {
                    _id: new Types.ObjectId(),
                    done: false,
                    doneAt: null,
                    pairId: null,
                    createdAt: new Date(clock++),
                    ...doc,
                } as unknown as Row;
                rows.push(row);
                return { _id: row._id, toObject: () => row };
            }),
        ),
    ),
    updateMany: vi.fn((filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
        const found = rows.filter((r) => matches(r, filter));
        found.forEach((r) => Object.assign(r, update.$set));
        return Promise.resolve({ matchedCount: found.length });
    }),
};
const subjectModel = {
    findOne: vi.fn((filter: { name: string }) => ({
        lean: vi.fn(() => Promise.resolve(subjects.find((s) => s.name === filter.name && s.isActive) ?? null)),
    })),
};

describe('할 일 · D-day API (/todos, /ddays)', () => {
    let app: INestApplication;
    const http = () => request(app.getHttpServer());
    const get = (path: string) => http().get(`/api/v1${path}`).set(AUTH);
    const post = (path: string, body: object) => http().post(`/api/v1${path}`).set(AUTH).send(body);
    const patch = (path: string, body: object) => http().patch(`/api/v1${path}`).set(AUTH).send(body);

    const todoBody = { content: '영어 단어 외우기', todoType: 'general', dueDate: '2026-11-10', timeSlot: 'none', subjectName: null };

    beforeAll(async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        app = await createCalendarTestApp({ todo: todoModel, subject: subjectModel });
    });
    afterAll(async () => {
        await app.close();
        vi.useRealTimers();
    });
    beforeEach(() => {
        rows = [];
        subjects = [];
        clock = 1_000;
        vi.clearAllMocks();
    });

    describe('할 일', () => {
        it('일반 할 일은 한 건만 만들어지고 그날 목록에 보인다 (shared Todo 모양)', async () => {
            const res = await post('/todos', todoBody);
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ content: '영어 단어 외우기', todoType: 'general', isDday: false, done: false, doneAt: null, dueTime: null, subjectId: null });
            expect(Todo.safeParse(res.body.data).success).toBe(true);
            expect(rows).toHaveLength(1);
            expect(String(rows[0]?.userId)).toBe(TEST_USER_ID);
            expect(rows[0]?.pairId).toBeNull();

            const list = await get('/todos?date=2026-11-10');
            expect(list.body.data.map((t: { content: string }) => t.content)).toEqual(['영어 단어 외우기']);
            expect((await get('/todos?date=2026-11-11')).body.data).toEqual([]);
        });

        it('과제 · 시험은 그날 목록용과 D-day 목록용 두 건이 한 쌍으로 만들어지고, 일반 할 일은 D-day가 생기지 않는다', async () => {
            const res = await post('/todos', { ...todoBody, content: '리포트 제출', todoType: 'assignment' });
            expect(res.status).toBe(201);
            expect(res.body.data.isDday).toBe(false); // 돌려주는 건 그날 목록에 보이는 쪽
            expect(rows).toHaveLength(2);
            expect(rows.map((r) => r.isDday).sort()).toEqual([false, true]);
            expect(String(rows[0]?.pairId)).toBe(String(rows[1]?.pairId));
            expect(rows[0]?.pairId).not.toBeNull();
            expect((await get('/todos?date=2026-11-10')).body.data).toHaveLength(1); // 그날 목록에는 한 번만

            await post('/todos', { ...todoBody, todoType: 'exam', content: '중간고사' });
            expect(rows).toHaveLength(4);
            await post('/todos', todoBody);
            expect(rows).toHaveLength(5); // 일반은 한 건만
            expect((await get('/ddays')).body.data.map((d: { title: string }) => d.title).sort()).toEqual(['리포트 제출', '중간고사']);
        });

        it('과목 이름이 목록에 있으면 subjectId를 연결하고, 없으면 이름만 남긴다', async () => {
            const math = { _id: new Types.ObjectId(), name: '수학', isActive: true };
            subjects.push(math);
            const a = await post('/todos', { ...todoBody, subjectName: '수학' });
            expect(a.body.data).toMatchObject({ subjectId: math._id.toString(), subjectName: '수학' });
            const b = await post('/todos', { ...todoBody, subjectName: '없는과목' });
            expect(b.body.data).toMatchObject({ subjectId: null, subjectName: '없는과목' });
        });

        it('시각은 직접 고른 경우(custom)에만 저장한다', async () => {
            const custom = await post('/todos', { ...todoBody, timeSlot: 'custom', dueTime: '14:30' });
            expect(custom.body.data).toMatchObject({ timeSlot: 'custom', dueTime: '14:30' });
            const am = await post('/todos', { ...todoBody, timeSlot: 'am', dueTime: '09:00' });
            expect(am.body.data).toMatchObject({ timeSlot: 'am', dueTime: null });
        });

        it('직접 시간(custom)인데 dueTime이 없거나 null이거나 형식이 틀리면 400, 아무것도 만들어지지 않는다', async () => {
            for (const todoType of ['general', 'assignment']) {
                const noTime = { ...todoBody, todoType, timeSlot: 'custom' };
                expect((await post('/todos', noTime)).status).toBe(400);
                expect((await post('/todos', { ...noTime, dueTime: null })).status).toBe(400);
                expect((await post('/todos', { ...noTime, dueTime: '' })).status).toBe(400);
                expect((await post('/todos', { ...noTime, dueTime: '24:00' })).status).toBe(400);
                expect((await post('/todos', { ...noTime, dueTime: '9:30' })).status).toBe(400);
                expect((await post('/todos', { ...noTime, dueTime: 1430 })).status).toBe(400);
            }
            expect(rows).toHaveLength(0);
        });

        it('직접 시간(custom)에 올바른 dueTime이 있으면 저장하고, 과제 · 시험은 짝에도 같은 시각이 들어간다', async () => {
            const res = await post('/todos', { ...todoBody, todoType: 'exam', timeSlot: 'custom', dueTime: '09:05' });
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ timeSlot: 'custom', dueTime: '09:05' });
            expect(rows.map((r) => r.dueTime)).toEqual(['09:05', '09:05']);
        });

        it('직접 시간이 아니면 dueTime 없이도 만들어지고, 보내도 저장하지 않는다', async () => {
            for (const timeSlot of ['none', 'am', 'pm']) {
                const without = await post('/todos', { ...todoBody, timeSlot });
                expect(without.status).toBe(201);
                expect(without.body.data.dueTime).toBeNull();
                const withNull = await post('/todos', { ...todoBody, timeSlot, dueTime: null });
                expect(withNull.status).toBe(201);
                const withTime = await post('/todos', { ...todoBody, timeSlot, dueTime: '14:30' });
                expect(withTime.status).toBe(201);
                expect(withTime.body.data.dueTime).toBeNull();
            }
            expect(rows.every((r) => !r.dueTime)).toBe(true);
            expect((await post('/todos', { ...todoBody, timeSlot: 'am', dueTime: '25:00' })).status).toBe(400); // 형식이 틀린 값은 지금처럼 400
        });

        it('완료 표시: 204, doneAt이 채워지고 다시 풀면 비워진다', async () => {
            const created = await post('/todos', todoBody);
            const id = created.body.data._id;
            expect((await patch(`/todos/${id}`, { done: true })).status).toBe(204);
            expect(rows[0]?.done).toBe(true);
            expect(rows[0]?.doneAt).toBeInstanceOf(Date);
            await patch(`/todos/${id}`, { done: false });
            expect(rows[0]?.done).toBe(false);
            expect(rows[0]?.doneAt).toBeNull();
        });

        it('과제를 완료하면 짝(D-day 쪽)도 같이 완료되어 D-day 목록에서 빠지고, 되돌리면 다시 나온다', async () => {
            const created = await post('/todos', { ...todoBody, todoType: 'assignment' });
            expect((await get('/ddays')).body.data).toHaveLength(1);
            await patch(`/todos/${created.body.data._id}`, { done: true });
            expect(rows.every((r) => r.done === true)).toBe(true);
            expect((await get('/ddays')).body.data).toEqual([]);
            await patch(`/todos/${created.body.data._id}`, { done: false });
            expect((await get('/ddays')).body.data).toHaveLength(1);
        });

        it('없는 할 일 · 남의 할 일 · 잘못된 id는 404, 남의 것은 바뀌지 않는다', async () => {
            expect((await patch(`/todos/${new Types.ObjectId()}`, { done: true })).status).toBe(404);
            const bad = await patch('/todos/abc', { done: true });
            expect(bad.status).toBe(404);
            expect(bad.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
            rows.push({ _id: new Types.ObjectId(), userId: new Types.ObjectId(), createdAt: new Date(), done: false, isDday: false, dueDate: '2026-11-10' } as unknown as Row);
            expect((await patch(`/todos/${rows[0]?._id}`, { done: true })).status).toBe(404);
            expect(rows[0]?.done).toBe(false);
        });

        it('남의 할 일은 목록에 안 보인다', async () => {
            rows.push({ _id: new Types.ObjectId(), userId: new Types.ObjectId(), createdAt: new Date(), isDday: false, dueDate: '2026-11-10', content: '남의 것' } as unknown as Row);
            expect((await get('/todos?date=2026-11-10')).body.data).toEqual([]);
        });
    });

    describe('D-day', () => {
        it('직접 만든 D-day는 D-day 목록에만 보이고 그날 할 일 목록에는 안 보인다 (shared DDay 모양)', async () => {
            const res = await post('/ddays', { title: '여행 출발', date: '2026-11-13' });
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ title: '여행 출발', date: '2026-11-13', source: 'manual', kind: '목표일', daysLeft: 5 });
            expect(DDay.safeParse(res.body.data).success).toBe(true);
            expect(rows).toHaveLength(1);
            expect((await get('/todos?date=2026-11-13')).body.data).toEqual([]);
            expect((await get('/ddays')).body.data).toHaveLength(1);
        });

        it('남은 일수가 적은 순으로 정렬되고, 지난 날짜는 지우지 않고 맨 뒤에 둔다', async () => {
            await post('/ddays', { title: '지난 일(오래)', date: '2026-10-20' }); // -19
            await post('/ddays', { title: '지난 일', date: '2026-11-01' }); // -7
            await post('/todos', { ...todoBody, content: '중간고사', todoType: 'exam', dueDate: '2026-11-20' }); // 12
            await post('/todos', { ...todoBody, content: '리포트', todoType: 'assignment', dueDate: '2026-11-09' }); // 1
            await post('/ddays', { title: '오늘', date: '2026-11-08' }); // 0
            const res = await get('/ddays');
            expect(res.body.data.map((d: { title: string; kind: string; daysLeft: number; source: string }) => [d.title, d.kind, d.daysLeft, d.source])).toEqual([
                ['오늘', '목표일', 0, 'manual'],
                ['리포트', '과제', 1, 'todo'],
                ['중간고사', '시험', 12, 'todo'],
                ['지난 일', '목표일', -7, 'manual'],
                ['지난 일(오래)', '목표일', -19, 'manual'],
            ]);
            res.body.data.forEach((d: unknown) => expect(DDay.safeParse(d).success).toBe(true));
        });

        it('오늘의 기준은 서울 자정이다 (UTC 15시 이후면 서울은 다음 날)', async () => {
            vi.setSystemTime(new Date('2026-11-08T15:30:00.000Z')); // 서울 11-09 00:30
            const res = await post('/ddays', { title: '내일 마감', date: '2026-11-10' });
            expect(res.body.data.daysLeft).toBe(1);
            vi.setSystemTime(NOW);
        });

        it('남의 D-day는 목록에 안 보인다', async () => {
            rows.push({ _id: new Types.ObjectId(), userId: new Types.ObjectId(), createdAt: new Date(), isDday: true, done: false, dueDate: '2026-11-10', content: '남의 것', todoType: 'general' } as unknown as Row);
            expect((await get('/ddays')).body.data).toEqual([]);
        });
    });

    describe('입력 검사와 로그인', () => {
        it.each([
            ['없는 날짜(2월 31일)', { ...todoBody, dueDate: '2026-02-31' }],
            ['날짜 형식', { ...todoBody, dueDate: '2026/11/10' }],
            ['잘못된 종류', { ...todoBody, todoType: 'homework' }],
            ['잘못된 시간대', { ...todoBody, timeSlot: 'noon' }],
            ['시각 형식', { ...todoBody, timeSlot: 'custom', dueTime: '25:00' }],
            ['내용 비어 있음', { ...todoBody, content: '' }],
            ['모르는 필드', { ...todoBody, hack: 1 }],
        ])('할 일 만들기 400: %s', async (_label, body) => {
            const res = await post('/todos', body);
            expect(res.status).toBe(400);
            expect(res.body).toHaveProperty('code');
            expect(rows).toHaveLength(0);
        });

        it('날짜 조회는 date가 꼭 있어야 하고 형식이 맞아야 한다', async () => {
            expect((await get('/todos')).status).toBe(400);
            expect((await get('/todos?date=2026-13-01')).status).toBe(400);
            expect((await get('/todos?date=20261110')).status).toBe(400);
        });

        it('완료 표시는 done이 불리언이어야 한다', async () => {
            const created = await post('/todos', todoBody);
            expect((await patch(`/todos/${created.body.data._id}`, { done: 'yes' })).status).toBe(400);
            expect((await patch(`/todos/${created.body.data._id}`, {})).status).toBe(400);
        });

        it('D-day 만들기도 제목 · 날짜를 검사한다', async () => {
            expect((await post('/ddays', { title: '', date: '2026-11-10' })).status).toBe(400);
            expect((await post('/ddays', { title: 'a', date: '2026-02-30' })).status).toBe(400);
            expect((await post('/ddays', { title: 'a', date: '11/10' })).status).toBe(400);
        });

        it('로그인하지 않으면 401', async () => {
            expect((await http().get('/api/v1/todos?date=2026-11-10')).status).toBe(401);
            expect((await http().get('/api/v1/ddays')).status).toBe(401);
            expect((await http().patch('/api/v1/todos/abc').send({ done: true })).status).toBe(401);
        });
    });
});
