import type { INestApplication } from '@nestjs/common';
import { RecurringGoal } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRecurringGoalsTestApp } from './recurring-goals-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

type Row = Record<string, unknown> & { _id: Types.ObjectId; userId: Types.ObjectId; deletedAt: Date | null };
type Filter = { _id?: Types.ObjectId; userId: Types.ObjectId; deletedAt: null };
let rows: Row[];

const sameId = (a: unknown, b: unknown) => String(a) === String(b);
const matches = (r: Row, f: Filter) =>
    (!f._id || sameId(r._id, f._id)) && sameId(r.userId, f.userId) && (r.deletedAt ?? null) === f.deletedAt;

// 실제 DB처럼 조건에 맞는 것만 다루는 가짜 모델 (스키마 기본값도 흉내 낸다)
const goalModel = {
    find: vi.fn((f: Filter) => ({
        sort: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(rows.filter((r) => matches(r, f)))) })),
    })),
    create: vi.fn((doc: Record<string, unknown>) => {
        const row = { _id: new Types.ObjectId(), pausedUntil: null, remindTime: null, deletedAt: null, ...doc } as unknown as Row;
        rows.push(row);
        return Promise.resolve({ toObject: () => row });
    }),
    findOneAndUpdate: vi.fn((f: Filter, u: { $set: Record<string, unknown> }) => ({
        lean: vi.fn(() => {
            const row = rows.find((r) => matches(r, f));
            if (row) Object.assign(row, u.$set);
            return Promise.resolve(row ?? null);
        }),
    })),
    updateOne: vi.fn((f: Filter, u: { $set: Record<string, unknown> }) => {
        const row = rows.find((r) => matches(r, f));
        if (row) Object.assign(row, u.$set);
        return Promise.resolve({ matchedCount: row ? 1 : 0 });
    }),
};

describe('반복 목표 API (/goals/recurring)', () => {
    let app: INestApplication;
    const url = (p = '') => `/api/v1/goals/recurring${p}`;
    const http = () => request(app.getHttpServer());
    const create = (body: object) => http().post(url()).set(AUTH).send(body);

    beforeAll(async () => {
        app = await createRecurringGoalsTestApp({ recurringGoal: goalModel });
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(() => {
        rows = [];
        vi.clearAllMocks();
    });

    it('이름과 요일만 보내면 앱과 같은 기본값으로 만들어진다 (201, shared RecurringGoal 모양)', async () => {
        const res = await create({ name: '영어 단어', days: [1, 2] });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            name: '영어 단어',
            days: [1, 2],
            targetMin: 30,
            subjectId: null,
            remindEnabled: false,
            remindTime: null,
            pausedUntil: null,
            streak: 0,
            isActive: true,
        });
        expect(RecurringGoal.safeParse(res.body.data).success).toBe(true);
        expect(String(rows[0]?.userId)).toBe(TEST_USER_ID);
    });

    it('요일은 정렬되어 저장되고, 보낸 값(목표 시간 · 알림 · 과목)이 그대로 나온다', async () => {
        const subjectId = new Types.ObjectId().toString();
        const res = await create({ name: '운동', days: [5, 1, 3], targetMin: 45, remindEnabled: true, remindTime: '07:30', subjectId });
        expect(res.body.data).toMatchObject({ days: [1, 3, 5], targetMin: 45, remindEnabled: true, remindTime: '07:30', subjectId });
        expect(RecurringGoal.safeParse(res.body.data).success).toBe(true);
    });

    it('수정하면 바뀐 값이 나오고 보내지 않은 필드는 그대로다', async () => {
        const created = await create({ name: '운동', days: [1], targetMin: 40 });
        const res = await http().patch(url(`/${created.body.data._id}`)).set(AUTH).send({ remindEnabled: true, remindTime: '07:30', days: [6, 0] });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ name: '운동', days: [0, 6], targetMin: 40, remindEnabled: true, remindTime: '07:30' });
        const list = await http().get(url()).set(AUTH);
        expect(list.body.data[0]).toMatchObject({ days: [0, 6], remindTime: '07:30' });
    });

    it('앱이 보내는 모양(_id 포함)으로 수정해도 받아 주되 _id · streak은 무시한다', async () => {
        const created = await create({ name: '독서', days: [2] });
        const res = await http()
            .patch(url(`/${created.body.data._id}`))
            .set(AUTH)
            .send({ _id: created.body.data._id, name: '독서 30분', days: [2, 4], targetMin: 30, remindEnabled: false, remindTime: '20:00', streak: 99 });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ _id: created.body.data._id, name: '독서 30분', days: [2, 4], streak: 0 });
    });

    it('일시정지 날짜(pausedUntil)와 과목은 값 또는 null로 바꾼다', async () => {
        const created = await create({ name: 'a', days: [1] });
        const id = created.body.data._id;
        const paused = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: '2026-12-01' });
        expect(paused.body.data.pausedUntil).toBe('2026-12-01T00:00:00.000Z');
        const cleared = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: null, subjectId: null });
        expect(cleared.body.data).toMatchObject({ pausedUntil: null, subjectId: null });
    });

    it('삭제하면 204, 목록에서는 빠지지만 DB에는 deletedAt과 함께 남는다', async () => {
        const gone = await create({ name: '지울 목표', days: [1] });
        await create({ name: '남길 목표', days: [2] });
        expect((await http().delete(url(`/${gone.body.data._id}`)).set(AUTH)).status).toBe(204);

        const list = await http().get(url()).set(AUTH);
        expect(list.body.data.map((g: { name: string }) => g.name)).toEqual(['남길 목표']);
        expect(rows).toHaveLength(2); // 문서는 지워지지 않았다
        expect(rows[0]?.deletedAt).toBeInstanceOf(Date);
        expect(rows[1]?.deletedAt).toBeNull();
    });

    it('삭제한 목표를 고치거나 다시 지우면 404', async () => {
        const created = await create({ name: 'a', days: [1] });
        const id = created.body.data._id;
        await http().delete(url(`/${id}`)).set(AUTH);
        const patched = await http().patch(url(`/${id}`)).set(AUTH).send({ name: 'b' });
        expect(patched.status).toBe(404);
        expect(patched.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        expect(rows[0]?.name).toBe('a');
        expect((await http().delete(url(`/${id}`)).set(AUTH)).status).toBe(404);
    });

    it('남의 목표 · 없는 목표 · 잘못된 id는 수정 · 삭제 모두 404, 남의 것은 그대로다', async () => {
        rows.push({ _id: new Types.ObjectId(), userId: new Types.ObjectId(), deletedAt: null, name: '남의 것' } as Row);
        const other = rows[0]!._id;
        expect((await http().patch(url(`/${other}`)).set(AUTH).send({ name: '가로채기' })).status).toBe(404);
        expect((await http().delete(url(`/${other}`)).set(AUTH)).status).toBe(404);
        expect(rows[0]?.name).toBe('남의 것');
        expect(rows[0]?.deletedAt).toBeNull();
        for (const id of [new Types.ObjectId().toString(), 'abc', '123']) {
            expect((await http().patch(url(`/${id}`)).set(AUTH).send({ name: 'x' })).status).toBe(404);
            expect((await http().delete(url(`/${id}`)).set(AUTH)).status).toBe(404);
        }
    });

    it('남의 목표는 목록에 섞이지 않는다', async () => {
        rows.push({ _id: new Types.ObjectId(), userId: new Types.ObjectId(), deletedAt: null, name: '남의 것', days: [1], targetMin: 30, remindEnabled: false, isActive: true } as Row);
        await create({ name: '내 것', days: [1] });
        const list = await http().get(url()).set(AUTH);
        expect(list.body.data.map((g: { name: string }) => g.name)).toEqual(['내 것']);
    });

    it.each([
        ['목표 시간 10분 미만', { name: 'a', days: [1], targetMin: 9 }],
        ['목표 시간 소수', { name: 'a', days: [1], targetMin: 30.5 }],
        ['요일 범위 밖', { name: 'a', days: [7] }],
        ['요일 음수', { name: 'a', days: [-1] }],
        ['요일 정수 아님', { name: 'a', days: [1.5] }],
        ['요일 중복', { name: 'a', days: [1, 1] }],
        ['요일 비어 있음', { name: 'a', days: [] }],
        ['요일 없음', { name: 'a' }],
        ['이름 없음', { days: [1] }],
        ['이름 비어 있음', { name: '', days: [1] }],
        ['이름 너무 김', { name: 'a'.repeat(101), days: [1] }],
        ['subjectId 형식', { name: 'a', days: [1], subjectId: 'abc' }],
        ['알림 시각 형식', { name: 'a', days: [1], remindTime: '25:00' }],
        ['일시정지 날짜 형식', { name: 'a', days: [1], pausedUntil: '2026/11/01' }],
        ['모르는 필드', { name: 'a', days: [1], hack: true }],
    ])('만들기 400: %s', async (_label, body) => {
        const res = await create(body);
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('code');
        expect(rows).toHaveLength(0);
    });

    it.each([
        ['목표 시간 10분 미만', { targetMin: 5 }],
        ['잘못된 요일', { days: [9] }],
        ['요일 없음(빈 배열)', { days: [] }],
        ['요일 null', { days: null }],
        ['목표 시간 null', { targetMin: null }],
    ])('수정 400: %s (값은 그대로)', async (_label, body) => {
        const created = await create({ name: 'a', days: [1], targetMin: 30 });
        expect((await http().patch(url(`/${created.body.data._id}`)).set(AUTH).send(body)).status).toBe(400);
        expect(rows[0]).toMatchObject({ days: [1], targetMin: 30 });
    });

    it('로그인하지 않으면 401', async () => {
        expect((await http().get(url())).status).toBe(401);
        expect((await http().post(url()).send({ name: 'a', days: [1] })).status).toBe(401);
        expect((await http().delete(url('/abc'))).status).toBe(401);
    });
});
