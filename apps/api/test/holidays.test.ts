import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    fixedHolidays,
    KasiHolidaySource,
    parseKasiResponse,
    type HolidayItem,
} from '../src/modules/calendar/holiday-source.js';
import type { HolidaysService } from '../src/modules/calendar/holidays.service.js';
import { AUTH_A, AUTH_B, createFakeStores, createHolidaysTestApp, type FakeStores } from './holidays-test-app.js';

describe('parseKasiResponse (공공데이터포털 응답 해석)', () => {
    const body = (items: unknown) => ({ response: { body: { items } } });

    it('여러 건: 공휴일(Y)만 날짜 순으로 뽑는다', () => {
        const json = body({
            item: [
                { dateName: '삼일절', isHoliday: 'Y', locdate: 20260301 },
                { dateName: '신정', isHoliday: 'Y', locdate: 20260101 },
                { dateName: '식목일', isHoliday: 'N', locdate: 20260405 },
            ],
        });
        expect(parseKasiResponse(json)).toEqual([
            { date: '2026-01-01', name: '신정' },
            { date: '2026-03-01', name: '삼일절' },
        ]);
    });

    it('한 건이면 객체로 와도 읽고, 같은 날 둘이면 이름을 잇고, 이상한 응답은 빈 배열', () => {
        expect(parseKasiResponse(body({ item: { dateName: '신정', isHoliday: 'Y', locdate: '20260101' } }))).toEqual([
            { date: '2026-01-01', name: '신정' },
        ]);
        expect(
            parseKasiResponse(
                body({
                    item: [
                        { dateName: '어린이날', isHoliday: 'Y', locdate: 20260505 },
                        { dateName: '부처님오신날', isHoliday: 'Y', locdate: 20260505 },
                    ],
                }),
            ),
        ).toEqual([{ date: '2026-05-05', name: '어린이날, 부처님오신날' }]);
        expect(parseKasiResponse(body(''))).toEqual([]);
        expect(parseKasiResponse(null)).toEqual([]);
    });

    it('fixedHolidays: 해마다 같은 8일', () => {
        expect(fixedHolidays(2027)).toHaveLength(8);
        expect(fixedHolidays(2027)[0]).toEqual({ date: '2027-01-01', name: '신정' });
    });
});

describe('KasiHolidaySource (외부 호출)', () => {
    afterEach(() => vi.unstubAllGlobals());
    const source = (key?: string) => new KasiHolidaySource({ get: () => key } as unknown as ConfigService);

    it('키가 없으면 외부를 부르지 않고 null', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(source(undefined).fetchYear(2026)).resolves.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('HTTP 오류나 네트워크 오류면 예외 없이 null', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
        await expect(source('k').fetchYear(2026)).resolves.toBeNull();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
        await expect(source('k').fetchYear(2026)).resolves.toBeNull();
    });
});

describe('공휴일 · 제외일 API (가짜 DB)', () => {
    let app: INestApplication;
    let service: HolidaysService;
    let stores: FakeStores;
    const fetchYear = vi.fn<(year: number) => Promise<HolidayItem[] | null>>();

    beforeEach(async () => {
        fetchYear.mockReset();
        stores = createFakeStores();
        ({ app, service } = await createHolidaysTestApp(stores, fetchYear));
    });
    afterEach(async () => {
        vi.useRealTimers();
        await app.close();
    });
    afterAll(() => vi.restoreAllMocks());

    const http = () => request(app.getHttpServer());
    const api = {
        list: (year: number | string, auth = AUTH_A) => http().get(`/api/v1/holidays?year=${year}`).set(auth),
        hide: (date: string, hidden: boolean, auth = AUTH_A) => http().patch(`/api/v1/holidays/${date}`).set(auth).send({ hidden }),
    };
    const fetched = [
        { date: '2026-01-01', name: '신정' },
        { date: '2026-02-17', name: '설날' },
    ];

    it('로그인 없이는 401', async () => {
        expect((await http().get('/api/v1/holidays?year=2026')).status).toBe(401);
    });

    it('키가 없으면(원본이 null) 고정 공휴일 8개를 돌려주고 저장하지 않는다', async () => {
        fetchYear.mockResolvedValue(null);
        const res = await api.list(2026);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(8);
        expect(res.body.data[0]).toEqual({ _id: '2026-01-01', name: '신정', hidden: false });
        expect(stores.pub).toHaveLength(0);
    });

    it('외부 응답이 저장되고 그대로 반환되며, 같은 해를 다시 부르면 외부를 부르지 않는다', async () => {
        fetchYear.mockResolvedValue(fetched);
        const first = await api.list(2026);
        expect(first.body.data).toEqual([
            { _id: '2026-01-01', name: '신정', hidden: false },
            { _id: '2026-02-17', name: '설날', hidden: false },
        ]);
        expect(stores.pub.map((r) => [r._id, r.source])).toEqual([
            ['2026-01-01', 'public_api'],
            ['2026-02-17', 'public_api'],
        ]);
        const second = await api.list(2026);
        expect(second.body.data).toEqual(first.body.data);
        expect(fetchYear).toHaveBeenCalledTimes(1);
    });

    it('외부 API가 예외를 던지거나 빈 결과여도 500이 아니라 고정 공휴일로 응답한다', async () => {
        fetchYear.mockRejectedValueOnce(new Error('boom'));
        const thrown = await api.list(2026);
        expect(thrown.status).toBe(200);
        expect(thrown.body.data).toHaveLength(8);
        fetchYear.mockResolvedValueOnce([]);
        expect((await api.list(2026)).body.data).toHaveLength(8);
        expect(stores.pub).toHaveLength(0);
    });

    it('저장이 실패해도 받아 온 결과로 응답한다', async () => {
        fetchYear.mockResolvedValue(fetched);
        stores.publicModel.bulkWrite = () => Promise.reject(new Error('db down'));
        const res = await api.list(2026);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
    });

    it('외부가 실패해도 이미 저장된 해는 저장된 값을 쓴다', async () => {
        fetchYear.mockResolvedValueOnce(fetched);
        await api.list(2026);
        fetchYear.mockRejectedValue(new Error('down'));
        expect((await api.list(2026)).body.data).toHaveLength(2);
    });

    it('year를 빼면 서울 기준 올해다 (UTC로는 아직 작년 12월 31일)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-12-31T16:00:00Z')); // 서울은 2027-01-01 01:00
        fetchYear.mockResolvedValue(null);
        const res = await http().get('/api/v1/holidays').set(AUTH_A);
        expect(res.status).toBe(200);
        expect(res.body.data[0]._id).toBe('2027-01-01');
        expect(fetchYear).toHaveBeenCalledWith(2027);
    });

    it('year가 이상하면 400', async () => {
        expect((await api.list('abc')).status).toBe(400);
        expect((await api.list(1999)).status).toBe(400);
    });

    it('공휴일 숨기기 · 다시 보이기, 다른 사람 숨김은 섞이지 않는다', async () => {
        fetchYear.mockResolvedValue(fetched);
        expect((await api.hide('2026-01-01', true)).status).toBe(204);
        expect((await api.hide('2026-01-01', true)).status).toBe(204); // 두 번 눌러도 한 건
        expect(stores.hid).toHaveLength(1);
        const hiddenOf = async (auth: typeof AUTH_A) =>
            (await api.list(2026, auth)).body.data.filter((h: { hidden: boolean }) => h.hidden).map((h: { _id: string }) => h._id);
        expect(await hiddenOf(AUTH_A)).toEqual(['2026-01-01']);
        expect(await hiddenOf(AUTH_B)).toEqual([]);
        await api.hide('2026-02-17', true, AUTH_B);
        expect(await hiddenOf(AUTH_A)).toEqual(['2026-01-01']);
        expect(await hiddenOf(AUTH_B)).toEqual(['2026-02-17']);
        expect((await api.hide('2026-01-01', false)).status).toBe(204);
        expect(await hiddenOf(AUTH_A)).toEqual([]);
        expect(await hiddenOf(AUTH_B)).toEqual(['2026-02-17']); // B의 숨김은 그대로
    });

    it('숨기기 요청이 잘못되면 400 (날짜 형식 · 없는 날짜 · hidden 누락)', async () => {
        expect((await api.hide('2026-1-1', true)).status).toBe(400);
        expect((await api.hide('2026-02-31', true)).status).toBe(400);
        expect((await http().patch('/api/v1/holidays/2026-01-01').set(AUTH_A).send({})).status).toBe(400);
    });

    it('제외일 추가 · 목록 · 삭제, 목록은 내 것만 만든 순서로', async () => {
        const add = (name: string, date: string, auth = AUTH_A) =>
            http().post('/api/v1/holidays/custom').set(auth).send({ name, date });
        const a1 = await add('여행', '2026-08-10');
        expect(a1.status).toBe(201);
        expect(a1.body.data).toMatchObject({ name: '여행', date: '2026-08-10' });
        await add('방학', '2026-07-01');
        await add('남의 것', '2026-09-01', AUTH_B);

        const list = await http().get('/api/v1/holidays/custom').set(AUTH_A);
        expect(list.body.data.map((h: { name: string }) => h.name)).toEqual(['여행', '방학']);

        const id = a1.body.data._id as string;
        expect((await http().delete(`/api/v1/holidays/custom/${id}`).set(AUTH_B)).status).toBe(404); // 다른 사람 것
        expect((await http().delete(`/api/v1/holidays/custom/${id}`).set(AUTH_A)).status).toBe(204);
        expect((await http().delete(`/api/v1/holidays/custom/${id}`).set(AUTH_A)).status).toBe(404); // 이미 지움
        expect((await http().delete('/api/v1/holidays/custom/not-an-id').set(AUTH_A)).status).toBe(404);
        expect((await http().get('/api/v1/holidays/custom').set(AUTH_A)).body.data).toHaveLength(1);
    });

    it('제외일 입력이 잘못되면 400', async () => {
        const post = (body: object) => http().post('/api/v1/holidays/custom').set(AUTH_A).send(body);
        expect((await post({ name: '여행', date: '2026-8-1' })).status).toBe(400);
        expect((await post({ name: '여행', date: '2026-02-30' })).status).toBe(400);
        expect((await post({ name: '', date: '2026-08-01' })).status).toBe(400);
        expect((await post({ name: 'x'.repeat(31), date: '2026-08-01' })).status).toBe(400);
        expect((await post({ date: '2026-08-01' })).status).toBe(400);
    });

    it('skipDates: 숨기지 않은 공휴일 + 내 제외일을 기간 안에서만 (양 끝 포함, 중복 없음, 정렬)', async () => {
        fetchYear.mockResolvedValue(fetched);
        await api.hide('2026-02-17', true); // 내가 숨긴 공휴일은 제외
        await http().post('/api/v1/holidays/custom').set(AUTH_A).send({ name: '여행', date: '2026-01-01' }); // 공휴일과 겹침
        await http().post('/api/v1/holidays/custom').set(AUTH_A).send({ name: '방학', date: '2026-01-05' });
        await http().post('/api/v1/holidays/custom').set(AUTH_B).send({ name: '남', date: '2026-01-03' });

        const [a, b] = [stores.hid[0]!.userId.toString(), '000000000000000000000000'];
        expect(await service.skipDates(a, '2026-01-01', '2026-02-28')).toEqual(['2026-01-01', '2026-01-05']);
        expect(await service.skipDates(a, '2026-01-02', '2026-01-04')).toEqual([]);
        expect(await service.skipDates(a, '2026-03-01', '2026-01-01')).toEqual([]);
        expect(await service.skipDates(b, '2026-01-01', '2026-02-28')).toEqual(['2026-01-01', '2026-02-17']);
    });
});
