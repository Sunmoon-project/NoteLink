// 진짜 MongoDB에서 할 일 · D-day API(FR-10)를 확인하는 테스트.
// 확인하는 것: 과제 · 시험은 D-day가 함께 생기고 일반 할 일은 안 생김, 완료하면 짝도 완료되어 D-day 목록에서 빠짐,
// D-day 정렬(남은 일수 적은 순, 지난 날짜는 맨 뒤), 다른 사람 할 일 수정 · 조회 불가(404), 잘못된 id(404), 날짜 형식(400), 인덱스.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/calendar-real-db.test.ts
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { CalendarController } from '../src/modules/calendar/calendar.controller.js';
import { CalendarService } from '../src/modules/calendar/calendar.service.js';
import { Todo, TodoSchema } from '../src/modules/calendar/schemas/todo.schema.js';
import { addDays } from '../src/modules/progress/week.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';
import { seoulDate } from '../src/modules/session/study-time.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_todos_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 할 일 · D-day 확인', () => {
    const me = new Types.ObjectId();
    const other = new Types.ObjectId();
    const tokens: Record<string, Types.ObjectId> = { 'token-me': me, 'token-other': other };
    const AUTH = { Authorization: 'Bearer token-me' };
    const AUTH_OTHER = { Authorization: 'Bearer token-other' };
    let app: INestApplication;
    let conn: Connection;
    const col = (name: string) => conn.collection(name);

    // 서울 기준 오늘과 며칠 뒤 날짜
    const today = seoulDate(new Date());
    const day = (n: number) => addDays(today, n);

    const http = () => request(app.getHttpServer());
    const get = (path: string, auth = AUTH) => http().get(`/api/v1${path}`).set(auth);
    const post = (path: string, body: object, auth = AUTH) => http().post(`/api/v1${path}`).set(auth).send(body);
    const patch = (path: string, body: object, auth = AUTH) => http().patch(`/api/v1${path}`).set(auth).send(body);
    const base = { content: '할 일', todoType: 'general', dueDate: day(3), timeSlot: 'none', subjectName: null };

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: Todo.name, schema: TodoSchema },
                    { name: Subject.name, schema: SubjectSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [CalendarController],
            providers: [
                CalendarService,
                {
                    provide: TokenService,
                    useValue: {
                        verifyAccess: (t: string) =>
                            tokens[t]
                                ? Promise.resolve({ userId: tokens[t].toString() })
                                : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                    },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        await Promise.all([conn.model(Todo.name).init(), conn.model(User.name).init(), conn.model(Subject.name).init()]);
        // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
        await col('users').insertMany([
            { _id: me, nickname: `me_${process.pid}`, email: `me_${process.pid}@example.com` },
            { _id: other, nickname: `other_${process.pid}`, email: `other_${process.pid}@example.com` },
        ]);
        await col('subjects').insertOne({ name: '수학', color: '#fff', sortOrder: 0, isActive: true, categoryId: null });
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    it('0) 같은 nickname의 사용자는 넣을 수 없다 (유일 인덱스)', async () => {
        await expect(col('users').insertOne({ nickname: `me_${process.pid}`, email: 'dup@example.com' })).rejects.toThrow(/duplicate key/);
    });

    it('1) 과제 · 시험은 D-day가 함께 생기고, 일반 할 일은 생기지 않는다', async () => {
        const general = await post('/todos', { ...base, content: '일반' });
        expect(general.status).toBe(201);
        expect(await col('todos').countDocuments({ userId: me, content: '일반' })).toBe(1);
        expect(await col('todos').countDocuments({ userId: me, content: '일반', isDday: true })).toBe(0);

        for (const [todoType, content] of [['assignment', '리포트'], ['exam', '중간고사']] as const) {
            const res = await post('/todos', { ...base, todoType, content, dueDate: day(todoType === 'exam' ? 10 : 2) });
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ content, isDday: false, done: false });
            const docs = await col('todos').find({ userId: me, content }).toArray();
            expect(docs.map((d) => d['isDday']).sort()).toEqual([false, true]);
            expect(String(docs[0]?.['pairId'])).toBe(String(docs[1]?.['pairId']));
        }
        const todayList = await get(`/todos?date=${day(2)}`);
        expect(todayList.body.data.map((t: { content: string }) => t.content)).toEqual(['리포트']); // 그날 목록에는 한 번만
        expect((await get('/ddays')).body.data.map((d: { title: string }) => d.title)).toEqual(['리포트', '중간고사']);
    });

    it('2) 과제를 완료하면 짝도 완료되고 D-day 목록에서 빠진다, 되돌리면 다시 나온다', async () => {
        const list = (await get(`/todos?date=${day(2)}`)).body.data as { _id: string }[];
        const id = list[0]!._id;
        expect((await patch(`/todos/${id}`, { done: true })).status).toBe(204);
        const docs = await col('todos').find({ userId: me, content: '리포트' }).toArray();
        expect(docs.every((d) => d['done'] === true && d['doneAt'] instanceof Date)).toBe(true);
        expect((await get('/ddays')).body.data.map((d: { title: string }) => d.title)).toEqual(['중간고사']);

        await patch(`/todos/${id}`, { done: false });
        const back = await col('todos').find({ userId: me, content: '리포트' }).toArray();
        expect(back.every((d) => d['done'] === false && d['doneAt'] === null)).toBe(true);
        expect((await get('/ddays')).body.data).toHaveLength(2);
    });

    it('3) D-day는 남은 일수가 적은 순이고 지난 날짜는 맨 뒤에 남는다', async () => {
        await post('/ddays', { title: '지난 일', date: day(-5) });
        await post('/ddays', { title: '오늘', date: day(0) });
        const res = await get('/ddays');
        expect(res.body.data.map((d: { title: string; daysLeft: number }) => [d.title, d.daysLeft])).toEqual([
            ['오늘', 0],
            ['리포트', 2],
            ['중간고사', 10],
            ['지난 일', -5],
        ]);
        expect(res.body.data.find((d: { title: string }) => d.title === '지난 일')).toMatchObject({ source: 'manual', kind: '목표일' });
    });

    it('4) 과목 이름이 subjects에 있으면 subjectId가 연결된다', async () => {
        const subject = (await col('subjects').findOne({ name: '수학' }))!;
        const res = await post('/todos', { ...base, content: '수학 숙제', subjectName: '수학' });
        expect(res.body.data).toMatchObject({ subjectId: subject._id.toString(), subjectName: '수학' });
    });

    it('5) 다른 사람 할 일은 보이지 않고 수정 · 삭제 시도는 404, 데이터는 그대로다', async () => {
        const mine = (await get(`/todos?date=${day(2)}`)).body.data[0] as { _id: string };
        expect((await get(`/todos?date=${day(2)}`, AUTH_OTHER)).body.data).toEqual([]);
        expect((await get('/ddays', AUTH_OTHER)).body.data).toEqual([]);

        const res = await patch(`/todos/${mine._id}`, { done: true }, AUTH_OTHER);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        expect(await col('todos').countDocuments({ userId: me, content: '리포트', done: true })).toBe(0);

        // 삭제 API는 없다: 어느 쪽이든 남의 id로는 아무것도 할 수 없다
        expect((await http().delete(`/api/v1/todos/${mine._id}`).set(AUTH_OTHER)).status).toBe(404);
        expect(await col('todos').countDocuments({ userId: me, content: '리포트' })).toBe(2);
    });

    it('6) 잘못된 id · 없는 id는 404', async () => {
        expect((await patch('/todos/abc', { done: true })).status).toBe(404);
        expect((await patch('/todos/123', { done: true })).status).toBe(404);
        expect((await patch(`/todos/${new Types.ObjectId()}`, { done: true })).status).toBe(404);
    });

    it('7) 날짜 형식이 틀리면 400이고 아무것도 저장되지 않는다', async () => {
        const before = await col('todos').countDocuments();
        expect((await post('/todos', { ...base, dueDate: '2026-02-31' })).status).toBe(400);
        expect((await post('/todos', { ...base, dueDate: '2026/11/10' })).status).toBe(400);
        expect((await post('/ddays', { title: 'x', date: '20261110' })).status).toBe(400);
        expect((await get('/todos?date=2026-13-01')).status).toBe(400);
        expect(await col('todos').countDocuments()).toBe(before);
    });

    it('8) 조회용 인덱스가 만들어져 있다', async () => {
        const keys = (await col('todos').indexes()).map((i) => JSON.stringify(i.key));
        expect(keys).toContain(JSON.stringify({ userId: 1, dueDate: 1 }));
        expect(keys).toContain(JSON.stringify({ userId: 1, isDday: 1, done: 1 }));
        expect(keys).toContain(JSON.stringify({ userId: 1, pairId: 1 }));
    });
});
