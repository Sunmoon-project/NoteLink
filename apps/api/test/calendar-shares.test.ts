import type { INestApplication } from '@nestjs/common';
import { GoneException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { CalendarSharesController } from '../src/modules/calendar/calendar-shares.controller.js';
import { CalendarSharesService } from '../src/modules/calendar/calendar-shares.service.js';
import type { CalendarShare } from '../src/modules/calendar/schemas/calendar-share.schema.js';
import type { CreateCalendarShareDto } from '../src/modules/calendar/dto/calendar-share.dto.js';

const ME = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const AUTH = { Authorization: 'Bearer token-me' };

// ---- 컨트롤러: 주소 · 상태 코드 · 입력 검증 (서비스는 가짜) ----
describe('캘린더 공유 API 입력 · 주소', () => {
    const fake = {
        list: vi.fn().mockResolvedValue([]),
        received: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ _id: 'x' }),
        subscribe: vi.fn().mockResolvedValue(undefined),
        revoke: vi.fn().mockResolvedValue(undefined),
    };
    let app: INestApplication;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            controllers: [CalendarSharesController],
            providers: [
                { provide: CalendarSharesService, useValue: fake },
                {
                    provide: TokenService,
                    useValue: {
                        verifyAccess: (t: string) =>
                            t === 'token-me'
                                ? Promise.resolve({ userId: ME.toString() })
                                : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                    },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
    });
    afterAll(async () => app.close());

    const post = (body: object) => request(app.getHttpServer()).post('/api/v1/calendar-shares').set(AUTH).send(body);
    const ok = { rangeStart: '2026-11-01', rangeEnd: '2026-11-30', expiresInDays: 7 };

    it('로그인 없이는 모두 401', async () => {
        const http = () => request(app.getHttpServer());
        expect((await http().get('/api/v1/calendar-shares')).status).toBe(401);
        expect((await http().get('/api/v1/calendar-shares/received')).status).toBe(401);
        expect((await http().post('/api/v1/calendar-shares')).status).toBe(401);
        expect((await http().post('/api/v1/calendar-shares/abc/subscribe')).status).toBe(401);
        expect((await http().delete('/api/v1/calendar-shares/abc')).status).toBe(401);
    });

    it('앱이 보내는 모양(기간 + 일수 또는 무제한)으로 만들면 201', async () => {
        expect((await post(ok)).status).toBe(201);
        expect((await post({ ...ok, expiresInDays: null })).status).toBe(201);
        expect(fake.create).toHaveBeenLastCalledWith(ME.toString(), { ...ok, expiresInDays: null });
    });

    it('날짜 형식 · 없는 날짜 · 유효기간 · 공유 범위가 잘못되면 400', async () => {
        for (const bad of [
            { ...ok, rangeStart: '2026-11-1' },
            { ...ok, rangeEnd: '2026-02-30' },
            { ...ok, expiresInDays: 0 },
            { ...ok, expiresInDays: 366 },
            { ...ok, expiresInDays: undefined }, // 무제한이면 null을 보내야 한다
            { ...ok, scopes: [] },
            { ...ok, scopes: ['todos', 'todos'] },
            { ...ok, scopes: ['diary'] },
            { ...ok, extra: 1 },
        ]) {
            expect((await post(bad)).status).toBe(400);
        }
    });

    it('received는 :id로 잡히지 않고, subscribe · 취소는 204', async () => {
        const http = () => request(app.getHttpServer());
        expect((await http().get('/api/v1/calendar-shares/received').set(AUTH)).status).toBe(200);
        expect(fake.received).toHaveBeenCalled();
        expect((await http().post('/api/v1/calendar-shares/abc/subscribe').set(AUTH)).status).toBe(204);
        expect(fake.subscribe).toHaveBeenCalledWith(ME.toString(), 'abc');
        expect((await http().delete('/api/v1/calendar-shares/abc').set(AUTH)).status).toBe(204);
        expect(fake.revoke).toHaveBeenCalledWith(ME.toString(), 'abc');
    });
});

// ---- 서비스: 토큰 · 기간 · 만료 · 오류 (가짜 모델) ----
describe('CalendarSharesService', () => {
    const create = vi.fn((doc: Record<string, unknown>) =>
        Promise.resolve({ toObject: () => ({ ...doc, _id: new Types.ObjectId(), createdAt: new Date('2026-11-13T00:00:00Z') }) }),
    );
    const findOne = vi.fn();
    const updateOne = vi.fn();
    const updateMany = vi.fn();
    const shareModel = { create, findOne, updateOne, updateMany };
    const ownerExists = vi.fn().mockResolvedValue({ _id: 'x' }); // 소유자는 탈퇴하지 않았다
    const userModel = { exists: ownerExists };
    const config = (v?: string) => ({ get: () => v }) as unknown as ConfigService;
    const svc = (base?: string) =>
        new CalendarSharesService(shareModel as unknown as Model<CalendarShare>, {} as never, {} as never, userModel as never, config(base));
    const dto = (over: Partial<CreateCalendarShareDto> = {}): CreateCalendarShareDto => ({
        rangeStart: '2026-11-01',
        rangeEnd: '2026-11-30',
        expiresInDays: 7,
        ...over,
    });
    const now = new Date('2026-11-13T00:00:00Z');

    it('만들기: 추측하기 어려운 32자리 토큰, 기본 범위 둘 다, 유효기간, 주소', async () => {
        const a = await svc().create(ME.toString(), dto(), now);
        const b = await svc('https://x.test/s').create(ME.toString(), dto({ expiresInDays: null }), now);
        expect(a.token).toMatch(/^[0-9a-f]{32}$/);
        expect(b.token).not.toBe(a.token);
        expect(a.scopes).toEqual(['todos', 'study']);
        expect(a.expiresAt).toBe('2026-11-20T00:00:00.000Z');
        expect(b.expiresAt).toBeNull();
        expect(a.url).toBe(`notelink.app/share/${a.token}`);
        expect(b.url).toBe(`x.test/s/${b.token}`); // https://는 서버가 뗀다
        expect(a.revokedAt).toBeNull();
        expect(a.subscribers).toEqual([]);
    });

    it('만들기: SHARE_BASE_URL이 없거나 · 프로토콜 · 끝 /가 있어도 url은 프로토콜 없이, 앱처럼 https://를 붙이면 한 번만', async () => {
        const cases: [string | undefined, string][] = [
            [undefined, 'notelink.app/share'],
            ['', 'notelink.app/share'],
            ['notelink.app/share', 'notelink.app/share'],
            ['https://notelink.app/share/', 'notelink.app/share'],
            ['http://x.y/s', 'x.y/s'],
            ['HTTPS://x.y/s//', 'x.y/s'],
        ];
        for (const [env, base] of cases) {
            const { url, token } = await svc(env).create(ME.toString(), dto(), now);
            expect(url).toBe(`${base}/${token}`);
            const shown = `https://${url}`; // 앱(CalShareScreen)이 복사 · 공유할 때 하는 것
            expect(shown.match(/https?:\/\//g)).toHaveLength(1);
            expect(shown.startsWith('https://')).toBe(true);
        }
    });

    it('만들기: 공유 범위를 고르면 그대로 저장하고, 기간이 거꾸로이거나 366일을 넘으면 400', async () => {
        expect((await svc().create(ME.toString(), dto({ scopes: ['todos'] }), now)).scopes).toEqual(['todos']);
        await expect(svc().create(ME.toString(), dto({ rangeStart: '2026-11-30', rangeEnd: '2026-11-01' }), now)).rejects.toMatchObject({ status: 400 });
        await expect(svc().create(ME.toString(), dto({ rangeStart: '2026-01-01', rangeEnd: '2027-01-02' }), now)).rejects.toMatchObject({ status: 400 });
        await expect(svc().create(ME.toString(), dto({ rangeStart: '2026-01-01', rangeEnd: '2027-01-01' }), now)).resolves.toBeTruthy(); // 366일
    });

    it('취소: 잘못된 id는 DB를 거치지 않고 404, 내 것이 아니면 404', async () => {
        await expect(svc().revoke(ME.toString(), 'not-an-id')).rejects.toBeInstanceOf(NotFoundException);
        expect(updateOne).not.toHaveBeenCalled();
        updateOne.mockResolvedValueOnce({ matchedCount: 0 });
        await expect(svc().revoke(ME.toString(), new Types.ObjectId().toString())).rejects.toBeInstanceOf(NotFoundException);
        updateOne.mockResolvedValueOnce({ matchedCount: 1 });
        await expect(svc().revoke(ME.toString(), new Types.ObjectId().toString())).resolves.toBeUndefined();
    });

    const found = (over: object) => {
        findOne.mockReset();
        findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: new Types.ObjectId(), ownerId: OTHER, revokedAt: null, expiresAt: null, ...over }) });
    };

    it('구독: 없음 · 취소는 404, 만료는 410 SHARE_EXPIRED', async () => {
        findOne.mockReset();
        findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
        await expect(svc().subscribe(ME.toString(), 'nope', now)).rejects.toBeInstanceOf(NotFoundException);
        found({ revokedAt: new Date() });
        await expect(svc().subscribe(ME.toString(), 'tok', now)).rejects.toBeInstanceOf(NotFoundException);
        found({ expiresAt: new Date(now.getTime() - 1) });
        await expect(svc().subscribe(ME.toString(), 'tok', now)).rejects.toBeInstanceOf(GoneException);
        found({ expiresAt: now }); // 만료 시각 정각도 만료
        await expect(svc().subscribe(ME.toString(), 'tok', now)).rejects.toBeInstanceOf(GoneException);
    });

    it('구독: 소유자가 탈퇴했으면(탈퇴 중 포함) 토큰이든 id든 404이고 아무것도 담지 않는다', async () => {
        updateOne.mockReset();
        ownerExists.mockResolvedValueOnce(null);
        found({});
        await expect(svc().subscribe(ME.toString(), 'tok', now)).rejects.toBeInstanceOf(NotFoundException);
        expect(ownerExists).toHaveBeenLastCalledWith({ _id: OTHER, deletedAt: null, withdrawingAt: null });
        const id = new Types.ObjectId();
        ownerExists.mockResolvedValueOnce(null);
        found({ _id: id, subscribers: [{ userId: ME, addedAt: now }] }); // 이미 담은 사람도 막는다
        await expect(svc().subscribe(ME.toString(), id.toString(), now)).rejects.toBeInstanceOf(NotFoundException);
        expect(updateOne).not.toHaveBeenCalled();
    });

    it('revokeAllByOwner: 그 사람이 만든 취소 안 한 공유만 revokedAt을 찍고, 취소한 개수를 돌려준다', async () => {
        updateMany.mockResolvedValueOnce({ modifiedCount: 3 });
        await expect(svc().revokeAllByOwner(ME.toString(), now)).resolves.toBe(3);
        expect(updateMany).toHaveBeenCalledWith({ ownerId: ME, revokedAt: null }, { $set: { revokedAt: now } });
    });

    describe('공유 id로 구독 (앱의 내 캘린더에 추가)', () => {
        const ID = new Types.ObjectId();
        const idKey = ID.toString();
        const THIRD = new Types.ObjectId();
        const sub = (u: Types.ObjectId) => ({ userId: u, addedAt: now });

        it('토큰 없는 제3자는 404이고 아무것도 바꾸지 않는다 (소유자 · 구독자가 아닌 사람)', async () => {
            updateOne.mockReset();
            found({ _id: ID, subscribers: [sub(THIRD)] });
            await expect(svc().subscribe(ME.toString(), idKey, now)).rejects.toBeInstanceOf(NotFoundException);
            found({ _id: ID, subscribers: [], expiresAt: new Date(now.getTime() - 1) }); // 만료 · 취소여도 존재를 알리지 않는다
            await expect(svc().subscribe(ME.toString(), idKey, now)).rejects.toBeInstanceOf(NotFoundException);
            found({ _id: ID, subscribers: [], revokedAt: new Date() });
            await expect(svc().subscribe(ME.toString(), idKey, now)).rejects.toBeInstanceOf(NotFoundException);
            expect(updateOne).not.toHaveBeenCalled();
        });

        it('이미 구독한 사람은 성공하고 다시 담지 않는다. 소유자도 성공', async () => {
            updateOne.mockReset();
            found({ _id: ID, subscribers: [sub(ME)] });
            await expect(svc().subscribe(ME.toString(), idKey, now)).resolves.toBeUndefined();
            found({ _id: ID, ownerId: ME, subscribers: [] });
            await expect(svc().subscribe(ME.toString(), idKey, now)).resolves.toBeUndefined();
            expect(updateOne).not.toHaveBeenCalled();
        });

        it('구독자라도 취소는 404, 만료는 410', async () => {
            found({ _id: ID, subscribers: [sub(ME)], revokedAt: new Date() });
            await expect(svc().subscribe(ME.toString(), idKey, now)).rejects.toBeInstanceOf(NotFoundException);
            found({ _id: ID, subscribers: [sub(ME)], expiresAt: new Date(now.getTime() - 1) });
            await expect(svc().subscribe(ME.toString(), idKey, now)).rejects.toBeInstanceOf(GoneException);
        });

        it('24자리 16진수면 id, 아니면 토큰으로 찾는다', async () => {
            found({});
            await svc().subscribe(ME.toString(), idKey, now).catch(() => undefined);
            expect(findOne.mock.calls[0]![0]).toEqual({ _id: ID });
            found({});
            await svc().subscribe(ME.toString(), 'a'.repeat(32), now);
            expect(findOne.mock.calls[0]![0]).toEqual({ token: 'a'.repeat(32) });
        });
    });

    it('구독: 내 링크는 아무 일 없이 성공, 남의 링크는 한 번만 담는 조건으로 추가', async () => {
        updateOne.mockReset();
        found({ ownerId: ME });
        await expect(svc().subscribe(ME.toString(), 'tok', now)).resolves.toBeUndefined();
        expect(updateOne).not.toHaveBeenCalled();
        found({});
        await svc().subscribe(ME.toString(), 'tok', now);
        const [filter, update] = updateOne.mock.calls[0]!;
        expect(filter['subscribers.userId']).toEqual({ $ne: ME });
        expect(update.$push.subscribers).toEqual({ userId: ME, addedAt: now });
    });
});
