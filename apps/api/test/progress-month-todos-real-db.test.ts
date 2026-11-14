// 진짜 MongoDB에서 월간 캘린더(GET /study/month)의 hasTodo(FR-09-04)를 확인하는 테스트.
// 확인하는 것: 과제 · 시험(짝 D-day가 생김) · 일반 · 완료한 할 일은 그 날짜가 true, 직접 만든 D-day만 있는 날 · 다른 사람 · 다른 달은 false,
// 같은 날 여러 개(짝 포함)여도 한 칸, 조회가 (userId, dueDate) 인덱스(IXSCAN)를 쓰는지.
// 할 일은 실제 할 일 API(POST /todos, PATCH /todos/:id, POST /ddays)로 만든다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/progress-month-todos-real-db.test.ts
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
import { ProgressService } from '../src/modules/progress/progress.service.js';
import { DailyRecord, DailyRecordSchema } from '../src/modules/progress/schemas/daily-record.schema.js';
import { WeeklyGoal, WeeklyGoalSchema } from '../src/modules/progress/schemas/weekly-goal.schema.js';
import { StudyProgressController } from '../src/modules/progress/study-progress.controller.js';
import { StudySession, StudySessionSchema } from '../src/modules/session/schemas/study-session.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_month_todos_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 월간 캘린더 hasTodo 확인', () => {
    // 테스트마다 새 사용자를 만들어 쓴다(서로의 데이터에 기대지 않는다). 토큰은 'token-<id>'
    const tokens: Record<string, Types.ObjectId> = {};
    let userSeq = 0;
    type TestUser = { id: Types.ObjectId; auth: { Authorization: string } };
    let app: INestApplication;
    let conn: Connection;
    const col = (name: string) => conn.collection(name);

    const http = () => request(app.getHttpServer());
    // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
    const newUser = async (): Promise<TestUser> => {
        const id = new Types.ObjectId();
        const n = userSeq++;
        await col('users').insertOne({ _id: id, nickname: `user_${n}_${process.pid}`, email: `user_${n}_${process.pid}@example.com` });
        tokens[`token-${id.toString()}`] = id;
        return { id, auth: { Authorization: `Bearer token-${id.toString()}` } };
    };
    const addTodo = (u: TestUser, dueDate: string, todoType: string, content: string) =>
        http().post('/api/v1/todos').set(u.auth).send({ content, todoType, dueDate, timeSlot: 'none', subjectName: null });
    const month = async (u: TestUser, ym: string) => {
        const res = await http().get('/api/v1/study/month').query({ ym }).set(u.auth);
        expect(res.status).toBe(200);
        return res.body.data as { studyDate: string; level: number; hasTodo: boolean }[];
    };
    const todoDays = async (u: TestUser, ym: string) => (await month(u, ym)).filter((d) => d.hasTodo).map((d) => d.studyDate);

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: Todo.name, schema: TodoSchema },
                    { name: Subject.name, schema: SubjectSchema },
                    { name: DailyRecord.name, schema: DailyRecordSchema },
                    { name: WeeklyGoal.name, schema: WeeklyGoalSchema },
                    { name: StudySession.name, schema: StudySessionSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [CalendarController, StudyProgressController],
            providers: [
                CalendarService,
                ProgressService,
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
        await Promise.all([conn.model(Todo.name).init(), conn.model(User.name).init()]);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    it('0) 할 일이 없으면 모든 날이 false다', async () => {
        const me = await newUser();
        const list = await month(me, '2026-11');
        expect(list).toHaveLength(30);
        expect(list.every((d) => d.hasTodo === false)).toBe(true);
    });

    it('1) 과제 · 일반 · 완료한 할 일이 있는 날만 true이고, D-day만 있는 날 · 다른 사람 · 다른 달은 false다', async () => {
        const me = await newUser();
        const other = await newUser();
        const assignment = await addTodo(me, '2026-11-05', 'assignment', '과제'); // 짝 D-day가 같은 날에 하나 더 생긴다
        expect(assignment.status).toBe(201);
        expect(await col('todos').countDocuments({ userId: me.id, dueDate: '2026-11-05' })).toBe(2);
        await addTodo(me, '2026-11-10', 'general', '일반');
        const done = await addTodo(me, '2026-11-15', 'general', '완료한 일반');
        await http().patch(`/api/v1/todos/${done.body.data._id}`).set(me.auth).send({ done: true });
        const doneExam = await addTodo(me, '2026-11-18', 'exam', '완료한 시험'); // 완료하면 짝 D-day도 완료
        await http().patch(`/api/v1/todos/${doneExam.body.data._id}`).set(me.auth).send({ done: true });
        await http().post('/api/v1/ddays').set(me.auth).send({ title: '직접 만든 D-day', date: '2026-11-25' }); // 할 일이 아니다
        await addTodo(other, '2026-11-12', 'general', '남의 할 일');
        await addTodo(me, '2026-12-01', 'general', '다음 달');
        await addTodo(me, '2026-10-31', 'assignment', '지난 달');
        expect(await col('todos').countDocuments({ userId: me.id, dueDate: '2026-11-15', done: true })).toBe(1);
        expect(await col('todos').countDocuments({ userId: me.id, dueDate: '2026-11-18', done: true })).toBe(2);

        expect(await todoDays(me, '2026-11')).toEqual(['2026-11-05', '2026-11-10', '2026-11-15', '2026-11-18']);
        // 다음 달 · 지난 달에는 그 달 할 일만 나온다
        expect(await todoDays(me, '2026-12')).toEqual(['2026-12-01']);
        expect(await todoDays(me, '2026-10')).toEqual(['2026-10-31']);
    });

    it('2) 같은 날 할 일이 여러 개여도 (과제 짝 포함) 한 칸이고, 사용자마다 따로 나온다', async () => {
        const me = await newUser();
        const other = await newUser();
        await addTodo(me, '2026-11-05', 'assignment', '과제'); // 짝 D-day까지 같은 날에 2건
        await addTodo(me, '2026-11-05', 'general', '같은 날 또 하나');
        await addTodo(me, '2026-11-05', 'exam', '같은 날 시험');
        await addTodo(me, '2026-11-10', 'general', '일반');
        await addTodo(other, '2026-11-12', 'general', '남의 할 일');
        expect(await col('todos').countDocuments({ userId: me.id, dueDate: '2026-11-05' })).toBeGreaterThan(3);
        const list = await month(me, '2026-11');
        expect(list.filter((d) => d.studyDate === '2026-11-05')).toHaveLength(1);
        expect(await todoDays(me, '2026-11')).toEqual(['2026-11-05', '2026-11-10']);
        expect(await todoDays(other, '2026-11')).toEqual(['2026-11-12']);
    });

    it('3) 직접 만든 D-day만 있는 달은 전부 false다', async () => {
        const me = await newUser();
        await http().post('/api/v1/ddays').set(me.auth).send({ title: 'D-day', date: '2027-03-10' });
        expect(await col('todos').countDocuments({ userId: me.id, dueDate: '2027-03-10', isDday: true })).toBe(1);
        expect(await todoDays(me, '2027-03')).toEqual([]);
    });

    it('4) 달 경계: 1일과 말일의 할 일도 그 달에 나온다', async () => {
        const me = await newUser();
        await addTodo(me, '2027-02-01', 'general', '1일');
        await addTodo(me, '2027-02-28', 'general', '말일');
        await addTodo(me, '2027-03-01', 'general', '다음 달 1일');
        expect(await todoDays(me, '2027-02')).toEqual(['2027-02-01', '2027-02-28']);
    });

    it('5) 할 일 날짜 조회는 (userId, dueDate) 인덱스를 쓴다 (COLLSCAN이 아니다)', async () => {
        const me = await newUser();
        // 이 테스트가 쓸 할 일을 직접 만든다. 11월은 두 건뿐이고 나머지 달에 흩어 둬서, 날짜 범위로 좁히는 인덱스가 더 좋은 계획이 된다
        await addTodo(me, '2026-11-05', 'general', '인덱스 확인용');
        await addTodo(me, '2026-11-20', 'general', '인덱스 확인용 2');
        for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '12']) {
            for (const d of ['03', '11', '19', '27']) await addTodo(me, `2026-${m}-${d}`, 'general', `다른 달 ${m}-${d}`);
        }
        const filter = { userId: me.id, dueDate: { $gte: '2026-11-01', $lte: '2026-11-30' }, isDday: false };
        const explained = await conn.db!.command({
            explain: { distinct: 'todos', key: 'dueDate', query: filter },
            verbosity: 'queryPlanner',
        });
        const plan = JSON.stringify(explained['queryPlanner'].winningPlan);
        expect(plan).toMatch(/IXSCAN/);
        expect(plan).not.toMatch(/COLLSCAN/);
        expect(plan).toContain('userId_1_dueDate_1');
    });
});
