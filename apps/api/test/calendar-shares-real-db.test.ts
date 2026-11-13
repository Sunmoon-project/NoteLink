// 진짜 MongoDB에서 캘린더 공유 API(FR-13)를 확인하는 테스트.
// 확인하는 것: 만들기 · 내 공유 목록 · 받은 공유 목록 · 구독(중복 · 동시 · 내 링크), 공유 범위(할 일 · 공부 기록)에 따라 보이는 날짜,
// 공유하지 않은 사람 데이터 차단, 만료(410) · 취소(404), 다른 사람 공유 취소 404, 잘못된 id, 서울 기준 날짜, 인덱스.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/calendar-shares-real-db.test.ts
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { CalendarSharesController } from '../src/modules/calendar/calendar-shares.controller.js';
import { CalendarSharesService } from '../src/modules/calendar/calendar-shares.service.js';
import { CalendarShare, CalendarShareSchema } from '../src/modules/calendar/schemas/calendar-share.schema.js';
import { Todo, TodoSchema } from '../src/modules/calendar/schemas/todo.schema.js';
import { DailyRecord, DailyRecordSchema } from '../src/modules/progress/schemas/daily-record.schema.js';
import { seoulDate } from '../src/modules/session/study-time.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_calendar_shares_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 캘린더 공유 확인', () => {
    const owner = new Types.ObjectId();
    const friend = new Types.ObjectId();
    const stranger = new Types.ObjectId();
    const tokens: Record<string, Types.ObjectId> = { 'token-owner': owner, 'token-friend': friend, 'token-stranger': stranger };
    const OWNER = { Authorization: 'Bearer token-owner' };
    const FRIEND = { Authorization: 'Bearer token-friend' };
    const STRANGER = { Authorization: 'Bearer token-stranger' };
    let app: INestApplication;
    let conn: Connection;
    const col = (name: string) => conn.collection(name);

    const http = () => request(app.getHttpServer());
    const get = (path: string, auth = OWNER) => http().get(`/api/v1${path}`).set(auth);
    const post = (path: string, body: object = {}, auth = OWNER) => http().post(`/api/v1${path}`).set(auth).send(body);
    const del = (path: string, auth = OWNER) => http().delete(`/api/v1${path}`).set(auth);
    const range = { rangeStart: '2026-11-01', rangeEnd: '2026-11-30' };
    const make = async (body: object = {}, auth = OWNER) => {
        const res = await post('/calendar-shares', { ...range, expiresInDays: 7, ...body }, auth);
        expect(res.status).toBe(201);
        return res.body.data as { _id: string; token: string };
    };
    const todo = (userId: Types.ObjectId, dueDate: string, over: object = {}) =>
        col('todos').insertOne({ userId, dueDate, content: '할 일', todoType: 'general', isDday: false, done: false, ...over });
    const study = (userId: Types.ObjectId, studyDate: string, totalSec: number) =>
        col('daily_records').insertOne({ userId, studyDate, totalSec, personalSec: totalSec, roomSec: 0, streakOk: false, items: [] });
    const receivedOf = async (auth: typeof FRIEND) => (await get('/calendar-shares/received', auth)).body.data as {
        _id: string; days: string[]; ownerNickname?: string; subscribers: unknown[];
    }[];

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: CalendarShare.name, schema: CalendarShareSchema },
                    { name: Todo.name, schema: TodoSchema },
                    { name: DailyRecord.name, schema: DailyRecordSchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [CalendarSharesController],
            providers: [
                CalendarSharesService,
                { provide: ConfigService, useValue: { get: () => undefined } }, // 링크 주소는 기본값
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
        await Promise.all([
            conn.model(CalendarShare.name).init(),
            conn.model(Todo.name).init(),
            conn.model(DailyRecord.name).init(),
            conn.model(User.name).init(),
        ]);
        // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
        await col('users').insertMany([
            { _id: owner, nickname: `owner_${process.pid}`, email: `owner_${process.pid}@example.com` },
            { _id: friend, nickname: `friend_${process.pid}`, email: `friend_${process.pid}@example.com` },
            { _id: stranger, nickname: `stranger_${process.pid}`, email: `stranger_${process.pid}@example.com` },
        ]);
    }, 30000);

    afterEach(async () => {
        await Promise.all(['calendar_shares', 'todos', 'daily_records'].map((n) => col(n).deleteMany({})));
    });

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    it('1) 만들기: 32자리 무작위 토큰 · 기본 범위 · 유효기간이 저장되고 내 목록에 최신순으로 나온다 (남의 목록에는 안 나온다)', async () => {
        const before = Date.now();
        const first = await post('/calendar-shares', { ...range, expiresInDays: 7 });
        expect(first.status).toBe(201);
        expect(first.body.data).toMatchObject({ ownerId: owner.toString(), scopes: ['todos', 'study'], revokedAt: null, subscribers: [] });
        expect(first.body.data.token).toMatch(/^[0-9a-f]{32}$/);
        expect(first.body.data.url).toBe(`notelink.app/share/${first.body.data.token}`);
        const exp = new Date(first.body.data.expiresAt).getTime();
        expect(exp).toBeGreaterThanOrEqual(before + 7 * 86400000);
        expect(exp).toBeLessThan(Date.now() + 7 * 86400000 + 1000);

        const second = await post('/calendar-shares', { ...range, expiresInDays: null, scopes: ['todos'] });
        expect(second.body.data).toMatchObject({ expiresAt: null, scopes: ['todos'] });
        expect(second.body.data.token).not.toBe(first.body.data.token);

        const mine = await get('/calendar-shares');
        expect(mine.body.data.map((s: { _id: string }) => s._id)).toEqual([second.body.data._id, first.body.data._id]);
        expect(await get('/calendar-shares', FRIEND).then((r) => r.body.data)).toEqual([]);
    });

    it('2) 만들기 입력이 잘못되면 400 (기간 거꾸로 · 366일 초과 · 날짜 형식)', async () => {
        expect((await post('/calendar-shares', { rangeStart: '2026-11-30', rangeEnd: '2026-11-01', expiresInDays: 7 })).status).toBe(400);
        expect((await post('/calendar-shares', { rangeStart: '2026-01-01', rangeEnd: '2027-01-02', expiresInDays: 7 })).status).toBe(400);
        expect((await post('/calendar-shares', { rangeStart: '2026-1-1', rangeEnd: '2026-11-01', expiresInDays: 7 })).status).toBe(400);
        expect(await col('calendar_shares').countDocuments()).toBe(0);
    });

    it('3) 구독: 토큰으로도 공유 id로도 담기고, 두 번 · 동시에 눌러도 한 번, 내 링크는 무변화', async () => {
        const share = await make();
        expect((await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND)).status).toBe(204);
        expect((await post(`/calendar-shares/${share._id}/subscribe`, {}, FRIEND)).status).toBe(204);
        await Promise.all([1, 2, 3].map(() => post(`/calendar-shares/${share.token}/subscribe`, {}, STRANGER)));
        expect((await post(`/calendar-shares/${share.token}/subscribe`, {}, OWNER)).status).toBe(204);

        const doc = await col('calendar_shares').findOne({ _id: new Types.ObjectId(share._id) });
        expect((doc!['subscribers'] as { userId: Types.ObjectId }[]).map((s) => String(s.userId)).sort()).toEqual(
            [friend.toString(), stranger.toString()].sort(),
        );
        // 만든 사람에게는 받은 사람이 보인다
        const mine = await get('/calendar-shares');
        expect(mine.body.data[0].subscribers.map((s: { userId: string }) => s.userId).sort()).toEqual([friend.toString(), stranger.toString()].sort());
    });

    it('4) 받은 공유 목록: 보낸 사람 닉네임 · 일정이 있는 날짜 · 다른 구독자는 숨김, 담지 않은 사람은 빈 목록', async () => {
        const share = await make();
        await todo(owner, '2026-11-05');
        await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND);

        const received = await receivedOf(FRIEND);
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ _id: share._id, ownerNickname: `owner_${process.pid}`, days: ['2026-11-05'], subscribers: [] });
        expect(await receivedOf(STRANGER)).toEqual([]); // 담지 않은 사람에게는 안 보인다
        expect(await receivedOf(OWNER)).toEqual([]); // 내가 만든 것은 받은 목록이 아니다
    });

    it('5) 공유 범위: todos만 · study만 · 둘 다에 따라 보이는 날짜가 다르다', async () => {
        await todo(owner, '2026-11-03');
        await todo(owner, '2026-11-09', { done: true }); // 완료한 할 일도 센다
        await study(owner, '2026-11-09', 600);
        await study(owner, '2026-11-12', 1800);
        const daysOf = async (scopes?: string[]) => {
            const share = await make(scopes ? { scopes } : {});
            await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND);
            return (await receivedOf(FRIEND)).find((r) => r._id === share._id)!.days;
        };
        expect(await daysOf(['todos'])).toEqual(['2026-11-03', '2026-11-09']);
        expect(await daysOf(['study'])).toEqual(['2026-11-09', '2026-11-12']);
        expect(await daysOf()).toEqual(['2026-11-03', '2026-11-09', '2026-11-12']);
    });

    it('6) 보이는 데이터 기준: 기간 밖 · D-day 짝 · 공부 0초 · 다른 사람의 할 일 · 공부 기록은 빠진다 (기간 양 끝은 포함)', async () => {
        await todo(owner, '2026-11-01'); // 시작일 포함
        await todo(owner, '2026-11-30'); // 종료일 포함
        await todo(owner, '2026-10-31'); // 기간 밖
        await todo(owner, '2026-12-01'); // 기간 밖
        await todo(owner, '2026-11-10', { isDday: true }); // D-day 짝은 할 일이 아니다 (월간 캘린더 hasTodo와 같은 기준)
        await study(owner, '2026-11-11', 0); // 공부 시간이 없는 날
        await todo(friend, '2026-11-15'); // 받는 사람 본인의 할 일은 공유 내용이 아니다
        await study(stranger, '2026-11-16', 900); // 공유하지 않은 사람의 기록
        await todo(stranger, '2026-11-17');
        const share = await make();
        await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND);
        expect((await receivedOf(FRIEND))[0]!.days).toEqual(['2026-11-01', '2026-11-30']);
    });

    it('7) 날짜는 서울 기준이다: 서울 날짜로 저장된 기록은 해가 바뀌어도 같은 날짜 문자열로 나온다', async () => {
        const instant = new Date('2026-12-31T16:00:00Z'); // UTC로는 12월 31일이지만 서울은 2027-01-01 01:00
        const seoulDay = seoulDate(instant);
        expect(seoulDay).toBe('2027-01-01');
        await study(owner, seoulDay, 3600);
        await study(owner, '2026-12-31', 600);
        const share = await make({ rangeStart: '2026-12-31', rangeEnd: '2027-01-01', scopes: ['study'] });
        await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND);
        expect((await receivedOf(FRIEND))[0]!.days).toEqual(['2026-12-31', '2027-01-01']);
        // 서울 1월 1일만 공유하면 12월 31일 기록은 안 보인다
        const jan = await make({ rangeStart: seoulDay, rangeEnd: seoulDay, scopes: ['study'] });
        await post(`/calendar-shares/${jan.token}/subscribe`, {}, FRIEND);
        expect((await receivedOf(FRIEND)).find((r) => r._id === jan._id)!.days).toEqual(['2027-01-01']);
    });

    it('8) 만료된 공유: 구독하면 410 SHARE_EXPIRED, 받은 목록에서는 빠지고 내 목록에는 남는다', async () => {
        const share = await make();
        await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND);
        expect(await receivedOf(FRIEND)).toHaveLength(1);

        await col('calendar_shares').updateOne({ _id: new Types.ObjectId(share._id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        const late = await post(`/calendar-shares/${share.token}/subscribe`, {}, STRANGER);
        expect(late.status).toBe(410);
        expect(late.body.code).toBe('SHARE_EXPIRED');
        expect(await receivedOf(FRIEND)).toEqual([]);
        expect((await get('/calendar-shares')).body.data.map((s: { _id: string }) => s._id)).toContain(share._id);
        expect(String((await col('calendar_shares').findOne({ _id: new Types.ObjectId(share._id) }))!['subscribers'].length)).toBe('1'); // 못 담았다
    });

    it('9) 취소된 공유: 내 목록 · 받은 목록에서 빠지고 구독은 404, 다시 취소해도 404 (지우지는 않고 revokedAt만 표시)', async () => {
        const share = await make();
        await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND);
        expect((await del(`/calendar-shares/${share._id}`)).status).toBe(204);

        expect(await receivedOf(FRIEND)).toEqual([]);
        expect((await get('/calendar-shares')).body.data).toEqual([]);
        expect((await post(`/calendar-shares/${share.token}/subscribe`, {}, STRANGER)).status).toBe(404);
        expect((await del(`/calendar-shares/${share._id}`)).status).toBe(404);
        const doc = await col('calendar_shares').findOne({ _id: new Types.ObjectId(share._id) });
        expect(doc!['revokedAt']).toBeInstanceOf(Date);
    });

    it('10) 다른 사람의 공유 취소는 404이고 공유는 그대로, 받은 사람도 취소할 수 없다', async () => {
        const share = await make();
        await post(`/calendar-shares/${share.token}/subscribe`, {}, FRIEND);
        expect((await del(`/calendar-shares/${share._id}`, STRANGER)).status).toBe(404);
        expect((await del(`/calendar-shares/${share._id}`, FRIEND)).status).toBe(404);
        const doc = await col('calendar_shares').findOne({ _id: new Types.ObjectId(share._id) });
        expect(doc!['revokedAt']).toBeNull();
        expect(await receivedOf(FRIEND)).toHaveLength(1);
    });

    it('11) 잘못된 id · 없는 토큰은 404', async () => {
        expect((await del('/calendar-shares/not-an-id')).status).toBe(404);
        expect((await del(`/calendar-shares/${new Types.ObjectId().toString()}`)).status).toBe(404);
        expect((await post('/calendar-shares/not-an-id/subscribe', {}, FRIEND)).status).toBe(404);
        expect((await post(`/calendar-shares/${'0'.repeat(32)}/subscribe`, {}, FRIEND)).status).toBe(404);
        expect((await post(`/calendar-shares/${new Types.ObjectId().toString()}/subscribe`, {}, FRIEND)).status).toBe(404);
    });

    it('12) 인덱스: 토큰은 유일하고 내 목록 · 받은 목록 인덱스가 있다', async () => {
        const dup = { token: 'same-token', ownerId: owner, rangeStart: '2026-11-01', rangeEnd: '2026-11-02', scopes: [], subscribers: [] };
        await col('calendar_shares').insertOne({ ...dup });
        await expect(col('calendar_shares').insertOne({ ...dup })).rejects.toThrow(/duplicate key/);
        const keys = (await col('calendar_shares').indexes()).map((i) => Object.keys(i.key).join(','));
        expect(keys).toContain('ownerId,revokedAt,createdAt');
        expect(keys).toContain('subscribers.userId');
    });
});
