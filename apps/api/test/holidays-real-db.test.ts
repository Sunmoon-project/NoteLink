// 진짜 MongoDB에서 공휴일 · 사용자 제외일 API(FR-12)를 확인하는 테스트.
// 확인하는 것: 키 없음 → 고정 공휴일(저장 안 함), 가짜 외부 응답이 저장 · 반환되고 재호출은 저장된 것을 씀(동시 호출도 한 건씩),
// 외부 실패 → 500 아님, 숨기기 · 해제(사용자별), 제외일 추가 · 목록 · 삭제(남의 것 404), 잘못된 id · 날짜(400/404), 서울 기준 날짜, 건너뛸 날짜 목록.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/holidays-real-db.test.ts
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types, type Connection } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { HolidaySource, type HolidayItem } from '../src/modules/calendar/holiday-source.js';
import { HolidaysController } from '../src/modules/calendar/holidays.controller.js';
import { HOLIDAY_REFETCH_MS, HolidaysService } from '../src/modules/calendar/holidays.service.js';
import { CustomHoliday, CustomHolidaySchema } from '../src/modules/calendar/schemas/custom-holiday.schema.js';
import { HiddenHoliday, HiddenHolidaySchema } from '../src/modules/calendar/schemas/hidden-holiday.schema.js';
import { HolidayFetch, HolidayFetchSchema } from '../src/modules/calendar/schemas/holiday-fetch.schema.js';
import { PublicHoliday, PublicHolidaySchema } from '../src/modules/calendar/schemas/public-holiday.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_holidays_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 공휴일 · 제외일 확인', () => {
    const me = new Types.ObjectId();
    const other = new Types.ObjectId();
    const tokens: Record<string, Types.ObjectId> = { 'token-me': me, 'token-other': other };
    const AUTH = { Authorization: 'Bearer token-me' };
    const AUTH_OTHER = { Authorization: 'Bearer token-other' };
    let app: INestApplication;
    let conn: Connection;
    let service: HolidaysService;
    const col = (name: string) => conn.collection(name);

    // 가짜 외부 API: 테스트마다 결과를 바꾸고, 몇 번 불렸는지 센다
    const fetchYear = vi.fn<(year: number) => Promise<HolidayItem[] | null>>();
    const fetched2026: HolidayItem[] = [
        { date: '2026-01-01', name: '신정' },
        { date: '2026-02-17', name: '설날' },
        { date: '2026-12-31', name: '가짜 연말 휴일' },
    ];

    const http = () => request(app.getHttpServer());
    const get = (path: string, auth = AUTH) => http().get(`/api/v1${path}`).set(auth);
    const post = (path: string, body: object, auth = AUTH) => http().post(`/api/v1${path}`).set(auth).send(body);
    const patch = (path: string, body: object, auth = AUTH) => http().patch(`/api/v1${path}`).set(auth).send(body);
    const del = (path: string, auth = AUTH) => http().delete(`/api/v1${path}`).set(auth);
    const clear = () => Promise.all(['public_holidays', 'holiday_fetches', 'hidden_holidays', 'custom_holidays'].map((n) => col(n).deleteMany({})));

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: PublicHoliday.name, schema: PublicHolidaySchema },
                    { name: HolidayFetch.name, schema: HolidayFetchSchema },
                    { name: HiddenHoliday.name, schema: HiddenHolidaySchema },
                    { name: CustomHoliday.name, schema: CustomHolidaySchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [HolidaysController],
            providers: [
                HolidaysService,
                { provide: HolidaySource, useValue: { fetchYear } },
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
        service = moduleRef.get(HolidaysService);
        await conn.dropDatabase();
        await Promise.all([
            conn.model(PublicHoliday.name).init(),
            conn.model(HolidayFetch.name).init(),
            conn.model(HiddenHoliday.name).init(),
            conn.model(CustomHoliday.name).init(),
            conn.model(User.name).init(),
        ]);
        // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
        await col('users').insertMany([
            { _id: me, nickname: `me_${process.pid}`, email: `me_${process.pid}@example.com` },
            { _id: other, nickname: `other_${process.pid}`, email: `other_${process.pid}@example.com` },
        ]);
    }, 30000);

    afterEach(async () => {
        fetchYear.mockReset();
        vi.useRealTimers();
        await clear();
    });

    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    it('1) 키가 없으면(원본이 null) 고정 공휴일 8개만 돌려주고 DB에는 저장하지 않는다', async () => {
        fetchYear.mockResolvedValue(null);
        const res = await get('/holidays?year=2026');
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(8);
        expect(res.body.data[0]).toEqual({ _id: '2026-01-01', name: '신정', hidden: false });
        expect(await col('public_holidays').countDocuments()).toBe(0);
    });

    it('2) 외부 응답이 저장되고 반환되며(_id가 날짜), 같은 해를 다시 · 동시에 불러도 외부는 한 번만 쓰고 한 건씩이다', async () => {
        fetchYear.mockResolvedValue(fetched2026);
        const first = await get('/holidays?year=2026');
        expect(first.body.data).toEqual(fetched2026.map((h) => ({ _id: h.date, name: h.name, hidden: false })));
        const stored = await col('public_holidays').find({}).sort({ _id: 1 }).toArray();
        expect(stored.map((d) => [d._id, d['name'], d['source']])).toEqual(
            fetched2026.map((h) => [h.date, h.name, 'public_api']),
        );
        expect(stored[0]!['createdAt']).toBeInstanceOf(Date);

        const again = await get('/holidays?year=2026');
        expect(again.body.data).toEqual(first.body.data);
        expect(fetchYear).toHaveBeenCalledTimes(1);

        // 저장이 비어 있는 해를 동시에 처음 부르면 외부를 여러 번 불러도 같은 날짜는 한 건만 저장된다
        await clear();
        fetchYear.mockResolvedValue(fetched2026);
        const results = await Promise.all([get('/holidays?year=2026'), get('/holidays?year=2026'), get('/holidays?year=2026')]);
        expect(results.every((r) => r.status === 200 && r.body.data.length === 3)).toBe(true);
        expect(await col('public_holidays').countDocuments()).toBe(3);
    });

    it('3) 해마다 따로 저장되고, 다른 해 저장분은 섞이지 않는다', async () => {
        fetchYear.mockResolvedValueOnce(fetched2026).mockResolvedValueOnce([{ date: '2027-01-01', name: '신정' }]);
        await get('/holidays?year=2026');
        const y2027 = await get('/holidays?year=2027');
        expect(y2027.body.data).toEqual([{ _id: '2027-01-01', name: '신정', hidden: false }]);
        expect((await get('/holidays?year=2026')).body.data).toHaveLength(3);
        expect(fetchYear).toHaveBeenCalledTimes(2);
    });

    it('4) 외부 API가 예외를 던지거나 빈 결과여도 500이 아니라 고정 공휴일로 응답하고, 저장된 해는 저장된 값을 쓴다', async () => {
        fetchYear.mockRejectedValueOnce(new Error('boom'));
        const thrown = await get('/holidays?year=2026');
        expect(thrown.status).toBe(200);
        expect(thrown.body.data).toHaveLength(8);
        fetchYear.mockResolvedValueOnce([]);
        expect((await get('/holidays?year=2026')).status).toBe(200);
        expect(await col('public_holidays').countDocuments()).toBe(0);

        fetchYear.mockResolvedValueOnce(fetched2026);
        await get('/holidays?year=2026');
        fetchYear.mockRejectedValue(new Error('down'));
        expect((await get('/holidays?year=2026')).body.data).toHaveLength(3);
    });

    it('5) 공휴일 숨기기 · 다시 보이기, 다른 사람 숨김이 섞이지 않는다 (사람 + 날짜 한 건)', async () => {
        fetchYear.mockResolvedValue(fetched2026);
        expect((await patch('/holidays/2026-01-01', { hidden: true })).status).toBe(204);
        expect((await patch('/holidays/2026-01-01', { hidden: true })).status).toBe(204);
        expect(await col('hidden_holidays').countDocuments({ userId: me })).toBe(1);
        // 동시에 눌러도 한 건
        await Promise.all([1, 2, 3].map(() => patch('/holidays/2026-02-17', { hidden: true })));
        expect(await col('hidden_holidays').countDocuments({ userId: me })).toBe(2);

        const hiddenOf = async (auth: typeof AUTH) =>
            ((await get('/holidays?year=2026', auth)).body.data as { _id: string; hidden: boolean }[]).filter((h) => h.hidden).map((h) => h._id);
        expect(await hiddenOf(AUTH)).toEqual(['2026-01-01', '2026-02-17']);
        expect(await hiddenOf(AUTH_OTHER)).toEqual([]);

        await patch('/holidays/2026-12-31', { hidden: true }, AUTH_OTHER);
        expect(await hiddenOf(AUTH_OTHER)).toEqual(['2026-12-31']);
        expect(await hiddenOf(AUTH)).toEqual(['2026-01-01', '2026-02-17']);

        expect((await patch('/holidays/2026-01-01', { hidden: false })).status).toBe(204);
        expect(await hiddenOf(AUTH)).toEqual(['2026-02-17']);
        expect(await hiddenOf(AUTH_OTHER)).toEqual(['2026-12-31']); // 남의 숨김은 그대로
    });

    it('6) 숨기기 요청이 잘못되면 400', async () => {
        expect((await patch('/holidays/2026-1-1', { hidden: true })).status).toBe(400);
        expect((await patch('/holidays/2026-02-31', { hidden: true })).status).toBe(400);
        expect((await patch('/holidays/2026-01-01', {})).status).toBe(400);
        expect((await patch('/holidays/2026-01-01', { hidden: 'yes' })).status).toBe(400);
        expect(await col('hidden_holidays').countDocuments()).toBe(0);
    });

    it('7) 제외일 추가 · 목록 · 삭제 — 내 것만 만든 순서로 보이고, 남의 것 삭제는 404', async () => {
        const a = await post('/holidays/custom', { name: '여행', date: '2026-08-10' });
        expect(a.status).toBe(201);
        expect(a.body.data).toMatchObject({ name: '여행', date: '2026-08-10' });
        expect(Types.ObjectId.isValid(a.body.data._id)).toBe(true);
        await post('/holidays/custom', { name: '방학', date: '2026-07-01' });
        await post('/holidays/custom', { name: '남의 것', date: '2026-09-01' }, AUTH_OTHER);

        const list = await get('/holidays/custom');
        expect(list.status).toBe(200);
        expect(list.body.data.map((h: { name: string }) => h.name)).toEqual(['여행', '방학']);
        expect((await get('/holidays/custom', AUTH_OTHER)).body.data).toHaveLength(1);

        const id = a.body.data._id as string;
        expect((await del(`/holidays/custom/${id}`, AUTH_OTHER)).status).toBe(404);
        expect(await col('custom_holidays').countDocuments({ userId: me })).toBe(2); // 안 지워짐
        expect((await del(`/holidays/custom/${id}`)).status).toBe(204);
        expect((await del(`/holidays/custom/${id}`)).status).toBe(404);
        expect((await get('/holidays/custom')).body.data.map((h: { name: string }) => h.name)).toEqual(['방학']);
    });

    it('8) 잘못된 id → 404, 잘못된 날짜 · 이름 · year → 400', async () => {
        expect((await del('/holidays/custom/not-an-id')).status).toBe(404);
        expect((await del(`/holidays/custom/${new Types.ObjectId().toString()}`)).status).toBe(404);
        expect((await post('/holidays/custom', { name: '여행', date: '2026-8-1' })).status).toBe(400);
        expect((await post('/holidays/custom', { name: '여행', date: '2026-02-30' })).status).toBe(400);
        expect((await post('/holidays/custom', { name: '', date: '2026-08-01' })).status).toBe(400);
        expect((await post('/holidays/custom', { name: 'x'.repeat(31), date: '2026-08-01' })).status).toBe(400);
        expect((await get('/holidays?year=abc')).status).toBe(400);
        expect(await col('custom_holidays').countDocuments()).toBe(0);
        expect((await http().get('/api/v1/holidays/custom')).status).toBe(401);
    });

    it('9) year를 빼면 서울 기준 올해다 (UTC로는 아직 작년 12월 31일)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-12-31T16:00:00Z')); // 서울은 2027-01-01 01:00
        fetchYear.mockResolvedValue([{ date: '2027-01-01', name: '신정' }]);
        const res = await get('/holidays');
        expect(res.status).toBe(200);
        expect(fetchYear).toHaveBeenCalledWith(2027);
        expect(res.body.data).toEqual([{ _id: '2027-01-01', name: '신정', hidden: false }]);
    });

    it('10) skipDates: 내가 숨기지 않은 공휴일 + 내 제외일을 기간 안에서 오름차순 · 중복 없이 (해가 넘어가도, 다른 사람 것은 빼고)', async () => {
        fetchYear.mockImplementation((year) =>
            Promise.resolve(year === 2026 ? fetched2026 : [{ date: '2027-01-01', name: '신정' }]),
        );
        await patch('/holidays/2026-02-17', { hidden: true }); // 내가 숨김
        await post('/holidays/custom', { name: '여행', date: '2026-01-01' }); // 공휴일과 겹침
        await post('/holidays/custom', { name: '방학', date: '2026-01-05' });
        await post('/holidays/custom', { name: '남', date: '2026-01-03' }, AUTH_OTHER);

        const mine = me.toString();
        expect(await service.skipDates(mine, '2026-01-01', '2026-02-28')).toEqual(['2026-01-01', '2026-01-05']);
        expect(await service.skipDates(mine, '2026-12-30', '2027-01-02')).toEqual(['2026-12-31', '2027-01-01']);
        expect(await service.skipDates(mine, '2026-03-01', '2026-01-01')).toEqual([]);
        expect(await service.skipDates(other.toString(), '2026-01-01', '2026-02-28')).toEqual([
            '2026-01-01',
            '2026-01-03',
            '2026-02-17',
        ]);
    });

    it('11) 인덱스: 숨김은 사람 + 날짜가 유일하다', async () => {
        const dup = { userId: me, date: '2026-05-05' };
        await col('hidden_holidays').insertOne({ ...dup });
        await expect(col('hidden_holidays').insertOne({ ...dup })).rejects.toThrow(/duplicate key/);
        await expect(col('hidden_holidays').insertOne({ userId: other, date: '2026-05-05' })).resolves.toBeTruthy();
    });

    describe('해마다 다 받음 표시 · 다시 받기', () => {
        const pub = () => col('public_holidays');
        const mine = () => me.toString();
        const names = async () => (await pub().find({}).sort({ _id: 1 }).toArray()).map((d) => [d._id, d['name'], d['source']]);

        it('12) 표시 없이 문서 몇 개만 있으면(저장이 중간에 끊긴 상태) 다시 받아 와 전체가 나오고 skipDates도 전체 기준이다', async () => {
            await pub().insertOne({ _id: '2026-01-01' as never, name: '신정', source: 'public_api', createdAt: new Date() });
            fetchYear.mockResolvedValue(fetched2026);

            const res = await get('/holidays?year=2026');
            expect(res.body.data).toHaveLength(3);
            expect(fetchYear).toHaveBeenCalledTimes(1);
            expect(await pub().countDocuments()).toBe(3);
            expect(await col('holiday_fetches').findOne({ _id: 2026 as never })).toMatchObject({ count: 3 });
            expect(await service.skipDates(mine(), '2026-01-01', '2026-12-31')).toEqual(['2026-01-01', '2026-02-17', '2026-12-31']);
            await get('/holidays?year=2026');
            expect(fetchYear).toHaveBeenCalledTimes(1);
        });

        it('13) 저장이 중간에 실패하면 표시를 쓰지 않아 다음 조회 때 다시 받는다', async () => {
            fetchYear.mockResolvedValue(fetched2026);
            const model = conn.model(PublicHoliday.name);
            const spy = vi.spyOn(model, 'bulkWrite').mockRejectedValueOnce(new Error('db down'));
            expect((await get('/holidays?year=2026')).status).toBe(200);
            spy.mockRestore();
            expect(await col('holiday_fetches').countDocuments()).toBe(0);

            expect((await get('/holidays?year=2026')).body.data).toHaveLength(3);
            expect(fetchYear).toHaveBeenCalledTimes(2);
            expect(await pub().countDocuments()).toBe(3);
        });

        it('14) 기간 안이면 외부를 부르지 않고, 기간이 지나면 다시 받아 정정 · 추가 · 삭제가 반영된다(다른 source · 숨김은 그대로)', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
            fetchYear.mockResolvedValue(fetched2026);
            await get('/holidays?year=2026');
            await pub().insertOne({ _id: '2026-07-07' as never, name: '직접 넣은 날', source: 'manual', createdAt: new Date() });
            await patch('/holidays/2026-01-01', { hidden: true });

            vi.setSystemTime(new Date(Date.now() + HOLIDAY_REFETCH_MS - 1000));
            await get('/holidays?year=2026');
            expect(fetchYear).toHaveBeenCalledTimes(1);

            vi.setSystemTime(new Date(Date.now() + 2000));
            fetchYear.mockResolvedValue([
                { date: '2026-01-01', name: '새해 첫날' },
                { date: '2026-05-05', name: '어린이날' },
                { date: '2026-12-31', name: '가짜 연말 휴일' },
            ]); // 2026-02-17은 사라짐
            const res = await get('/holidays?year=2026');
            expect(fetchYear).toHaveBeenCalledTimes(2);
            expect(res.body.data).toEqual([
                { _id: '2026-01-01', name: '새해 첫날', hidden: true },
                { _id: '2026-05-05', name: '어린이날', hidden: false },
                { _id: '2026-07-07', name: '직접 넣은 날', hidden: false },
                { _id: '2026-12-31', name: '가짜 연말 휴일', hidden: false },
            ]);
            expect(await names()).toEqual([
                ['2026-01-01', '새해 첫날', 'public_api'],
                ['2026-05-05', '어린이날', 'public_api'],
                ['2026-07-07', '직접 넣은 날', 'manual'],
                ['2026-12-31', '가짜 연말 휴일', 'public_api'],
            ]);
            expect(await col('hidden_holidays').countDocuments()).toBe(1);
            await get('/holidays?year=2026');
            expect(fetchYear).toHaveBeenCalledTimes(2);
        });

        it('15) 다시 받기에 실패하면 기존 값으로 200이다', async () => {
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-01-10T00:00:00Z'));
            fetchYear.mockResolvedValue(fetched2026);
            await get('/holidays?year=2026');
            vi.setSystemTime(new Date(Date.now() + HOLIDAY_REFETCH_MS + 1000));

            fetchYear.mockRejectedValueOnce(new Error('down'));
            const res = await get('/holidays?year=2026');
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(3);
            expect(await pub().countDocuments()).toBe(3);
        });

        it('16) 같은 해를 동시에 처음 조회하면 외부는 한 번만 부른다', async () => {
            fetchYear.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(fetched2026), 50)));
            const results = await Promise.all([1, 2, 3, 4].map(() => get('/holidays?year=2026')));
            expect(results.every((r) => r.status === 200 && r.body.data.length === 3)).toBe(true);
            expect(fetchYear).toHaveBeenCalledTimes(1);
            expect(await pub().countDocuments()).toBe(3);
        });
    });
});
