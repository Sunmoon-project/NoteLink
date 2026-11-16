import type { INestApplication } from '@nestjs/common';
import { RecurringGoal } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsePausedUntil } from '../src/modules/progress/recurring-goals.service.js';
import { createRecurringGoalsTestApp } from './recurring-goals-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

type Row = Record<string, unknown> & { _id: Types.ObjectId; userId: Types.ObjectId; deletedAt: Date | null };
type Filter = { _id?: Types.ObjectId; userId: Types.ObjectId; deletedAt: null };
let rows: Row[];
let subjects: { _id: Types.ObjectId; isActive: boolean }[];

const sameId = (a: unknown, b: unknown) => String(a) === String(b);
const matches = (r: Row, f: Filter) =>
    (!f._id || sameId(r._id, f._id)) && sameId(r.userId, f.userId) && (r.deletedAt ?? null) === f.deletedAt;

// 실제 DB처럼 조건에 맞는 것만 다루는 가짜 모델 (스키마 기본값도 흉내 낸다)
const goalModel = {
    find: vi.fn((f: Filter) => ({
        sort: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(rows.filter((r) => matches(r, f)))) })),
    })),
    create: vi.fn((doc: Record<string, unknown>) => {
        // 스키마 기본값과 timestamps(createdAt)도 흉내 낸다
        const row = { _id: new Types.ObjectId(), pausedUntil: null, remindTime: null, deletedAt: null, createdAt: new Date(), ...doc } as unknown as Row;
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

// 과목 모델의 가짜: _id가 같고 isActive 조건에 맞는 것만 찾는다
const subjectModel = {
    findOne: vi.fn((f: { _id: Types.ObjectId; isActive: boolean }) => ({
        lean: vi.fn(() => Promise.resolve(subjects.find((s) => sameId(s._id, f._id) && s.isActive === f.isActive) ?? null)),
    })),
};

describe('반복 목표 API (/goals/recurring)', () => {
    let app: INestApplication;
    const url = (p = '') => `/api/v1/goals/recurring${p}`;
    const http = () => request(app.getHttpServer());
    const create = (body: object) => http().post(url()).set(AUTH).send(body);

    beforeAll(async () => {
        app = await createRecurringGoalsTestApp({ recurringGoal: goalModel, subject: subjectModel });
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(() => {
        rows = [];
        subjects = [];
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
        const subjectOid = new Types.ObjectId();
        subjects.push({ _id: subjectOid, isActive: true });
        const subjectId = subjectOid.toString();
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
        const subjectOid = new Types.ObjectId();
        subjects.push({ _id: subjectOid, isActive: true });
        const withSubject = await http().patch(url(`/${id}`)).set(AUTH).send({ subjectId: subjectOid.toString() });
        expect(withSubject.body.data.subjectId).toBe(subjectOid.toString());
        const paused = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: '2026-12-01' });
        expect(paused.body.data.pausedUntil).toBe('2026-11-30T15:00:00.000Z'); // 서울 자정
        const cleared = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: null, subjectId: null });
        expect(cleared.body.data).toMatchObject({ pausedUntil: null, subjectId: null });
    });

    it('없는 과목 · 비활성 과목은 만들 때도 수정할 때도 400, 활성 과목은 저장된다', async () => {
        const active = { _id: new Types.ObjectId(), isActive: true };
        const inactive = { _id: new Types.ObjectId(), isActive: false };
        subjects.push(active, inactive);
        const missing = new Types.ObjectId().toString();

        for (const subjectId of [missing, inactive._id.toString()]) {
            const res = await create({ name: 'a', days: [1], subjectId });
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
        }
        expect(rows).toHaveLength(0);

        const ok = await create({ name: 'a', days: [1], subjectId: active._id.toString() });
        expect(ok.status).toBe(201);
        expect(ok.body.data.subjectId).toBe(active._id.toString());

        const id = ok.body.data._id;
        for (const subjectId of [missing, inactive._id.toString()]) {
            expect((await http().patch(url(`/${id}`)).set(AUTH).send({ subjectId })).status).toBe(400);
        }
        expect(String(rows[0]?.subjectId)).toBe(active._id.toString()); // 그대로
        const cleared = await http().patch(url(`/${id}`)).set(AUTH).send({ subjectId: null });
        expect(cleared.body.data.subjectId).toBeNull(); // null은 확인 없이 통과
    });

    describe('pausedUntil', () => {
        const pause = async (pausedUntil: string | null) => {
            const created = await create({ name: 'a', days: [1] });
            return http().patch(url(`/${created.body.data._id}`)).set(AUTH).send({ pausedUntil });
        };

        it.each([
            ['YYYY-MM-DD는 서울 자정', '2026-12-01', '2026-11-30T15:00:00.000Z'],
            ['Z 일시는 그 순간 그대로', '2026-12-01T03:00:00Z', '2026-12-01T03:00:00.000Z'],
            ['+09:00 일시는 같은 순간', '2026-12-01T12:00:00+09:00', '2026-12-01T03:00:00.000Z'],
            ['-05:00 일시도 같은 순간', '2026-12-01T00:00:00-05:00', '2026-12-01T05:00:00.000Z'],
            ['밀리초가 있는 Z 일시', '2026-12-01T03:00:00.500Z', '2026-12-01T03:00:00.500Z'],
        ])('%s', async (_label, input, expected) => {
            const res = await pause(input);
            expect(res.status).toBe(200);
            expect(res.body.data.pausedUntil).toBe(expected);
            expect(RecurringGoal.safeParse(res.body.data).success).toBe(true);
        });

        it.each([
            ['시간대 없는 일시', '2026-12-01T12:00:00'],
            ['시간대 없는 일시(분까지)', '2026-12-01T12:00'],
            ['없는 날짜', '2026-02-31'],
            ['없는 날짜(일시)', '2026-02-31T00:00:00Z'],
            ['없는 시각', '2026-12-01T25:00:00Z'],
            ['슬래시 날짜', '2026/12/01'],
            ['빈 문자열', ''],
        ])('400: %s', async (_label, input) => {
            const res = await pause(input);
            expect(res.status).toBe(400);
            expect(rows[0]?.pausedUntil).toBeNull();
        });

        it('null은 쉬는 날짜를 해제한다', async () => {
            const created = await create({ name: 'a', days: [1] });
            const id = created.body.data._id;
            await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: '2026-12-01' });
            const res = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: null });
            expect(res.body.data.pausedUntil).toBeNull();
            expect(rows[0]?.pausedUntil).toBeNull();
        });

        it('만들 때도 같은 규칙이다', async () => {
            expect((await create({ name: 'a', days: [1], pausedUntil: '2026-12-01T12:00:00' })).status).toBe(400);
            const ok = await create({ name: 'a', days: [1], pausedUntil: '2026-12-01' });
            expect(ok.body.data.pausedUntil).toBe('2026-11-30T15:00:00.000Z');
        });

        it('서버 시간대(TZ)가 달라도 저장되는 순간이 같다', async () => {
            const before = process.env['TZ'];
            const offsets: Record<string, number> = { UTC: 0, 'Asia/Seoul': -540, 'America/Los_Angeles': 480, 'Pacific/Kiritimati': -840 };
            try {
                for (const [tz, offset] of Object.entries(offsets)) {
                    process.env['TZ'] = tz;
                    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(offset); // TZ 변경이 실제로 먹혔는지
                    expect((await pause('2026-12-01')).body.data.pausedUntil, tz).toBe('2026-11-30T15:00:00.000Z');
                    expect((await pause('2026-12-01T12:00:00+09:00')).body.data.pausedUntil, tz).toBe('2026-12-01T03:00:00.000Z');
                    expect(parsePausedUntil('2026-12-01').toISOString(), tz).toBe('2026-11-30T15:00:00.000Z');
                }
            } finally {
                if (before === undefined) delete process.env['TZ'];
                else process.env['TZ'] = before;
            }
        });
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

describe('반복 목표 streak 계산 연결 (가짜 DB)', () => {
    let app: INestApplication;
    const records: unknown[] = [];
    const dailyFind = vi.fn(() => ({ lean: () => Promise.resolve(records) }));
    const skipDates = vi.fn((_u: string, _from: string, _to: string) => Promise.resolve([] as string[]));

    beforeAll(async () => {
        app = await createRecurringGoalsTestApp({
            recurringGoal: goalModel,
            subject: subjectModel,
            dailyRecord: { find: dailyFind },
            skipDates,
        });
    });
    afterAll(async () => {
        vi.useRealTimers();
        await app.close();
    });
    beforeEach(() => {
        rows = [];
        subjects = [];
        records.length = 0;
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-14T03:00:00Z')); // 서울 토요일 정오
    });

    const seed = (over: Record<string, unknown> = {}) =>
        rows.push({
            _id: new Types.ObjectId(),
            userId: new Types.ObjectId(TEST_USER_ID),
            name: '운동',
            days: [1, 3],
            targetMin: 30,
            remindEnabled: false,
            isActive: true,
            deletedAt: null,
            createdAt: new Date('2026-10-01T00:00:00+09:00'),
            ...over,
        } as Row);
    const day = (studyDate: string, totalSec = 1800) => ({ studyDate, totalSec, items: [] });

    it('목록의 streak은 공부 기록으로 계산하고, 기록과 건너뛸 날은 목표 수와 상관없이 한 번씩만 읽는다', async () => {
        seed();
        seed({ name: '독서', days: [2] });
        records.push(day('2026-11-02'), day('2026-11-04'), day('2026-11-09'), day('2026-11-11'));
        const res = await request(app.getHttpServer()).get('/api/v1/goals/recurring').set(AUTH);
        expect(res.status).toBe(200);
        expect(res.body.data.map((g: { streak: number }) => g.streak)).toEqual([2, 0]);
        expect(dailyFind).toHaveBeenCalledTimes(1);
        expect(skipDates).toHaveBeenCalledTimes(1);
        // 가장 이른 목표 만든 날부터 이번 주 일요일까지
        expect(skipDates).toHaveBeenCalledWith(TEST_USER_ID, '2026-10-01', '2026-11-15');
    });

    it('쉬는 목표만 있으면 아무것도 읽지 않고 0이다', async () => {
        seed({ isActive: false });
        const res = await request(app.getHttpServer()).get('/api/v1/goals/recurring').set(AUTH);
        expect(res.body.data[0].streak).toBe(0);
        expect(dailyFind).not.toHaveBeenCalled();
        expect(skipDates).not.toHaveBeenCalled();
    });

    it('만들 때도 같은 streak 계산을 쓴다: 오늘 목표 시간을 이미 채운 사용자가 오늘 요일로 만들면 바로 이어서 목록과 같은 값이다', async () => {
        records.push(day('2026-11-14')); // 오늘(토) 30분을 이미 공부했다
        const created = await request(app.getHttpServer()).post('/api/v1/goals/recurring').set(AUTH).send({ name: '토요일 공부', days: [6], targetMin: 30 });
        expect(created.status).toBe(201);
        expect(created.body.data.streak).toBe(1); // 이번 주 대상 날(오늘)을 이미 달성
        const listed = await request(app.getHttpServer()).get('/api/v1/goals/recurring').set(AUTH);
        expect(listed.body.data[0].streak).toBe(created.body.data.streak);
        expect(dailyFind).toHaveBeenCalledTimes(2); // 만들 때 한 번, 목록에서 한 번
    });

    it('수정 응답도 현재 설정으로 계산한 streak을 준다', async () => {
        seed({ name: '운동', days: [2] }); // 화요일 목표라서 기록이 없으면 지난 주를 못 한 것
        records.push(day('2026-11-03'), day('2026-11-10'));
        const id = String(rows[0]!._id);
        const res = await request(app.getHttpServer()).patch(`/api/v1/goals/recurring/${id}`).set(AUTH).send({ name: '운동2' });
        expect(res.status).toBe(200);
        expect(res.body.data.streak).toBe(2);
    });
});
