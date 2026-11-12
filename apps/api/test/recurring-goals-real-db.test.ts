// 진짜 MongoDB에서 반복 목표 API(FR-11)를 확인하는 테스트.
// 확인하는 것: 만들기 기본값, 수정, 소프트 삭제(목록에서만 빠지고 DB에 남음), 삭제한 목표 수정 404,
// 목표 시간 · 요일 검증 400, 다른 사람 목표 수정 · 삭제 404와 목록 분리, 잘못된 id 404, 인덱스.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/recurring-goals-real-db.test.ts
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
import { RecurringGoalsController } from '../src/modules/progress/recurring-goals.controller.js';
import { RecurringGoalsService } from '../src/modules/progress/recurring-goals.service.js';
import { RecurringGoal, RecurringGoalSchema } from '../src/modules/progress/schemas/recurring-goal.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_recurring_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 반복 목표 확인', () => {
    const me = new Types.ObjectId();
    const other = new Types.ObjectId();
    const tokens: Record<string, Types.ObjectId> = { 'token-me': me, 'token-other': other };
    const AUTH = { Authorization: 'Bearer token-me' };
    const AUTH_OTHER = { Authorization: 'Bearer token-other' };
    let app: INestApplication;
    let conn: Connection;
    const col = (name: string) => conn.collection(name);

    const http = () => request(app.getHttpServer());
    const url = (p = '') => `/api/v1/goals/recurring${p}`;
    const create = (body: object, auth = AUTH) => http().post(url()).set(auth).send(body);
    const list = async (auth = AUTH) => (await http().get(url()).set(auth)).body.data as { _id: string; name: string }[];

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: RecurringGoal.name, schema: RecurringGoalSchema },
                    { name: Subject.name, schema: SubjectSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [RecurringGoalsController],
            providers: [
                RecurringGoalsService,
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
        await Promise.all([conn.model(RecurringGoal.name).init(), conn.model(User.name).init(), conn.model(Subject.name).init()]);
        // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
        await col('users').insertMany([
            { _id: me, nickname: `me_${process.pid}`, email: `me_${process.pid}@example.com` },
            { _id: other, nickname: `other_${process.pid}`, email: `other_${process.pid}@example.com` },
        ]);
    }, 30000);

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    it('0) 같은 nickname의 사용자는 넣을 수 없다 (유일 인덱스)', async () => {
        await expect(col('users').insertOne({ nickname: `me_${process.pid}`, email: 'dup@example.com' })).rejects.toThrow(/duplicate key/);
    });

    it('1) 이름과 요일만 보내면 앱과 같은 기본값으로 저장된다', async () => {
        const res = await create({ name: '영어 단어', days: [3, 1] });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
            name: '영어 단어', days: [1, 3], targetMin: 30, subjectId: null, remindEnabled: false,
            remindTime: null, pausedUntil: null, streak: 0, isActive: true,
        });
        const saved = await col('recurring_goals').findOne({ _id: new Types.ObjectId(res.body.data._id) });
        expect(saved).toMatchObject({ userId: me, name: '영어 단어', days: [1, 3], targetMin: 30, deletedAt: null });
    });

    it('2) 수정하면 바뀐 값이 나오고 DB에도 반영된다', async () => {
        const [goal] = await list();
        const res = await http()
            .patch(url(`/${goal!._id}`))
            .set(AUTH)
            .send({ name: '영어 단어 40분', targetMin: 40, remindEnabled: true, remindTime: '07:30', pausedUntil: '2026-12-01' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ name: '영어 단어 40분', targetMin: 40, remindEnabled: true, remindTime: '07:30', days: [1, 3], pausedUntil: '2026-11-30T15:00:00.000Z' }); // 서울 자정
        const stored = await col('recurring_goals').findOne({ _id: new Types.ObjectId(goal!._id) });
        expect(stored).toMatchObject({ targetMin: 40, remindTime: '07:30' });
        expect(stored!['pausedUntil']).toEqual(new Date('2026-11-30T15:00:00.000Z'));
        // 앱이 보내는 모양(_id 포함)도 받는다
        const again = await http().patch(url(`/${goal!._id}`)).set(AUTH).send({ _id: goal!._id, name: '영어 단어', days: [2], targetMin: 30, remindEnabled: false, remindTime: '20:00' });
        expect(again.status).toBe(200);
        expect(again.body.data).toMatchObject({ days: [2], targetMin: 30, remindTime: '20:00' });
    });

    it('3) 다른 사람 목표는 목록에 섞이지 않고, 수정 · 삭제는 404이며 그대로 남는다', async () => {
        const theirs = await create({ name: '남의 목표', days: [5] }, AUTH_OTHER);
        expect(theirs.status).toBe(201);
        expect((await list()).map((g) => g.name)).toEqual(['영어 단어']);
        expect((await list(AUTH_OTHER)).map((g) => g.name)).toEqual(['남의 목표']);

        const id = theirs.body.data._id as string;
        const patched = await http().patch(url(`/${id}`)).set(AUTH).send({ name: '가로채기' });
        expect(patched.status).toBe(404);
        expect(patched.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        expect((await http().delete(url(`/${id}`)).set(AUTH)).status).toBe(404);
        expect(await col('recurring_goals').findOne({ _id: new Types.ObjectId(id) })).toMatchObject({ name: '남의 목표', deletedAt: null });
    });

    it('4) 삭제하면 목록에서 빠지고 DB에는 deletedAt과 함께 남으며, 삭제한 목표 수정 · 재삭제는 404', async () => {
        const [mine] = await list();
        expect((await http().delete(url(`/${mine!._id}`)).set(AUTH)).status).toBe(204);
        expect(await list()).toEqual([]);
        const saved = await col('recurring_goals').findOne({ _id: new Types.ObjectId(mine!._id) });
        expect(saved).not.toBeNull();
        expect(saved!['deletedAt']).toBeInstanceOf(Date);
        expect(saved).toMatchObject({ name: '영어 단어', userId: me });

        expect((await http().patch(url(`/${mine!._id}`)).set(AUTH).send({ name: '되살리기' })).status).toBe(404);
        expect((await http().delete(url(`/${mine!._id}`)).set(AUTH)).status).toBe(404);
        expect(await col('recurring_goals').countDocuments({ userId: me })).toBe(1);
        expect(await list(AUTH_OTHER)).toHaveLength(1); // 남의 목록은 그대로
    });

    it('5) 목표 시간 10분 미만 · 잘못된 요일 · 요일 없음은 400이고 아무것도 저장되지 않는다', async () => {
        const before = await col('recurring_goals').countDocuments();
        for (const body of [
            { name: 'a', days: [1], targetMin: 9 },
            { name: 'a', days: [7] },
            { name: 'a', days: [-1] },
            { name: 'a', days: [1, 1] },
            { name: 'a', days: [] },
            { name: 'a' },
            { name: 'a', days: [1], remindTime: '24:00' },
            { name: 'a', days: [1], subjectId: 'abc' },
        ]) {
            expect((await create(body)).status, JSON.stringify(body)).toBe(400);
        }
        const kept = await create({ name: '유지', days: [1], targetMin: 30 });
        expect((await http().patch(url(`/${kept.body.data._id}`)).set(AUTH).send({ targetMin: 5 })).status).toBe(400);
        expect((await http().patch(url(`/${kept.body.data._id}`)).set(AUTH).send({ days: [] })).status).toBe(400);
        expect(await col('recurring_goals').findOne({ _id: new Types.ObjectId(kept.body.data._id) })).toMatchObject({ targetMin: 30, days: [1] });
        expect(await col('recurring_goals').countDocuments()).toBe(before + 1);
    });

    it('6) 잘못된 id · 없는 id는 404', async () => {
        for (const id of ['abc', '123', new Types.ObjectId().toString()]) {
            expect((await http().patch(url(`/${id}`)).set(AUTH).send({ name: 'x' })).status).toBe(404);
            expect((await http().delete(url(`/${id}`)).set(AUTH)).status).toBe(404);
        }
    });

    it('7) 없는 과목 · 비활성 과목은 만들 때도 수정할 때도 400, 활성 과목은 저장된다', async () => {
        const active = new Types.ObjectId();
        const inactive = new Types.ObjectId();
        const subject = { color: '#fff', sortOrder: 0, categoryId: null };
        await col('subjects').insertMany([
            { _id: active, name: '활성', isActive: true, ...subject },
            { _id: inactive, name: '비활성', isActive: false, ...subject },
        ]);
        const missing = new Types.ObjectId().toString();
        const before = await col('recurring_goals').countDocuments();

        for (const subjectId of [missing, inactive.toString()]) {
            const res = await create({ name: 'a', days: [1], subjectId });
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('VALIDATION_FAILED');
        }
        expect(await col('recurring_goals').countDocuments()).toBe(before);

        const ok = await create({ name: '과목 있는 목표', days: [1], subjectId: active.toString() });
        expect(ok.status).toBe(201);
        expect(ok.body.data.subjectId).toBe(active.toString());
        expect(await col('recurring_goals').findOne({ _id: new Types.ObjectId(ok.body.data._id) })).toMatchObject({ subjectId: active });

        const id = ok.body.data._id as string;
        for (const subjectId of [missing, inactive.toString()]) {
            expect((await http().patch(url(`/${id}`)).set(AUTH).send({ subjectId })).status).toBe(400);
        }
        expect(await col('recurring_goals').findOne({ _id: new Types.ObjectId(id) })).toMatchObject({ subjectId: active });
        expect((await http().patch(url(`/${id}`)).set(AUTH).send({ subjectId: null })).body.data.subjectId).toBeNull();
    });

    it('8) pausedUntil: 날짜는 서울 자정, 시간대 붙은 일시는 같은 순간으로 저장되고, 시간대 없는 일시 · 없는 날짜는 400, null은 해제한다 (서버 TZ가 달라도 같다)', async () => {
        const created = await create({ name: '쉬는 날짜', days: [2] });
        const id = created.body.data._id as string;
        const stored = async () => (await col('recurring_goals').findOne({ _id: new Types.ObjectId(id) }))!['pausedUntil'];
        const before = process.env['TZ'];
        try {
            for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Seoul']) {
                process.env['TZ'] = tz;
                const date = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: '2026-12-01' });
                expect(date.body.data.pausedUntil, tz).toBe('2026-11-30T15:00:00.000Z');
                expect(await stored()).toEqual(new Date('2026-11-30T15:00:00.000Z'));

                for (const input of ['2026-12-01T03:00:00Z', '2026-12-01T12:00:00+09:00']) {
                    const res = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: input });
                    expect(res.body.data.pausedUntil, `${tz} ${input}`).toBe('2026-12-01T03:00:00.000Z');
                    expect(await stored()).toEqual(new Date('2026-12-01T03:00:00.000Z'));
                }
            }
        } finally {
            if (before === undefined) delete process.env['TZ'];
            else process.env['TZ'] = before;
        }

        for (const input of ['2026-12-01T12:00:00', '2026-02-31']) {
            expect((await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: input })).status, input).toBe(400);
        }
        expect(await stored()).toEqual(new Date('2026-12-01T03:00:00.000Z')); // 400이면 그대로
        const cleared = await http().patch(url(`/${id}`)).set(AUTH).send({ pausedUntil: null });
        expect(cleared.body.data.pausedUntil).toBeNull();
        expect(await stored()).toBeNull();
    });

    it('9) 조회용 인덱스가 만들어져 있다', async () => {
        const keys = (await col('recurring_goals').indexes()).map((i) => JSON.stringify(i.key));
        expect(keys).toContain(JSON.stringify({ userId: 1, deletedAt: 1, createdAt: 1 }));
    });
});
