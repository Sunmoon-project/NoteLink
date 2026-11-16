import type { INestApplication } from '@nestjs/common';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionTestApp } from './session-test-app.js';
import { AUTH, TEST_USER_ID } from './shop-test-app.js';

const owner = new Types.ObjectId(TEST_USER_ID);
const itemId = new Types.ObjectId();
const subjectId = new Types.ObjectId();
const sessionId = new Types.ObjectId();

// 서울 정오 (UTC 03:00). 서울 날짜는 2026-11-04
const NOW = new Date('2026-11-04T03:00:00.000Z');
const TODAY = '2026-11-04';
const secondsAgo = (sec: number) => new Date(NOW.getTime() - sec * 1000);

// 가짜 트랜잭션의 session. 모든 쓰기에 이 session이 따라가는지 확인한다
const tx = { id: 'fake-tx' };

let record: Record<string, unknown> | null;
let row: Record<string, unknown> | null;
let openRows: Record<string, unknown>[]; // 이 사람이 이미 열어 둔(끝나지 않은) 세션들
let subject: Record<string, unknown> | null;

const dailyModel = {
    findOneAndUpdate: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(record)) })),
    findOne: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(record)) })),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
};
const sessionModel = {
    create: vi.fn().mockResolvedValue([{}]),
    find: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(openRows)) })),
    findOne: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(row)) })),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
};
const subjectModel = {
    find: vi.fn(() => ({
        sort: vi.fn(() => ({
            lean: vi.fn().mockResolvedValue([
                { _id: subjectId, categoryId: null, name: '수학', color: '#3b6e5b', sortOrder: 0, isActive: true },
            ]),
        })),
    })),
    findOne: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(subject)) })),
};
const connection = {
    transaction: vi.fn((work: (session: typeof tx) => Promise<unknown>) => work(tx)),
};
const points = { earn: vi.fn().mockResolvedValue(130), countEarned: vi.fn().mockResolvedValue(0) };

function makeRecord(): Record<string, unknown> {
    return {
        _id: new Types.ObjectId(),
        userId: owner,
        studyDate: TODAY,
        totalSec: 600,
        personalSec: 600,
        roomSec: 0,
        streakOk: false,
        items: [
            { _id: itemId, title: '수학 문제집', subjectId: null, subjectName: '수학', goalMin: 60, accumulatedSec: 600 },
        ],
    };
}

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        _id: sessionId,
        userId: owner,
        studyDate: TODAY,
        studyItemId: itemId,
        roomId: null,
        mode: 'personal',
        status: 'running',
        startedAt: secondsAgo(700),
        endedAt: null,
        durationSec: 0,
        departureCount: 0,
        endReason: null,
        isAbuse: false,
        pointsEarned: 0,
        pauses: [],
        ...overrides,
    };
}

describe('공부 기록 API (/study, /subjects, /study-sessions)', () => {
    let app: INestApplication;
    const api = (path: string) => `/api/v1${path}`;

    beforeAll(async () => {
        vi.useFakeTimers({ toFake: ['Date'] }); // 시간만 고정 (네트워크 타이머는 그대로)
        app = await createSessionTestApp({
            studySession: sessionModel,
            dailyRecord: dailyModel,
            subject: subjectModel,
            connection,
            points,
        });
    });

    afterAll(async () => {
        await app.close();
        vi.useRealTimers();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        vi.setSystemTime(NOW);
        record = makeRecord();
        row = makeRow();
        openRows = [];
        subject = null;
    });

    describe('GET /study/today', () => {
        it('로그인하지 않으면 401', async () => {
            const res = await request(app.getHttpServer()).get(api('/study/today'));
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
        });

        it('오늘 기록을 { data }로 돌려주고, 없으면 만들도록 요청한다 (서울 날짜 기준)', async () => {
            const res = await request(app.getHttpServer()).get(api('/study/today')).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                data: {
                    _id: (record as { _id: Types.ObjectId })._id.toString(),
                    studyDate: TODAY,
                    totalSec: 600,
                    personalSec: 600,
                    roomSec: 0,
                    streakOk: false,
                    items: [
                        {
                            _id: itemId.toString(),
                            title: '수학 문제집',
                            subjectId: null,
                            subjectName: '수학',
                            goalMin: 60,
                            accumulatedSec: 600,
                        },
                    ],
                },
            });
            expect(dailyModel.findOneAndUpdate).toHaveBeenCalledWith(
                { userId: owner, studyDate: TODAY },
                expect.objectContaining({ $setOnInsert: expect.objectContaining({ totalSec: 0, items: [] }) }),
                { upsert: true, returnDocument: 'after' },
            );
        });

        it('UTC로는 아직 어제여도 서울이 다음 날이면 서울 날짜로 찾는다', async () => {
            vi.setSystemTime(new Date('2026-11-04T15:30:00.000Z')); // 서울 11/05 00:30
            await request(app.getHttpServer()).get(api('/study/today')).set(AUTH);
            expect(dailyModel.findOneAndUpdate).toHaveBeenCalledWith(
                { userId: owner, studyDate: '2026-11-05' },
                expect.anything(),
                expect.anything(),
            );
        });
    });

    describe('GET /subjects', () => {
        it('로그인하지 않으면 401', async () => {
            const res = await request(app.getHttpServer()).get(api('/subjects'));
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
        });

        it('쓰는 과목을 정렬 순서대로 돌려준다', async () => {
            const res = await request(app.getHttpServer()).get(api('/subjects')).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                data: [
                    { _id: subjectId.toString(), categoryId: null, name: '수학', color: '#3b6e5b', sortOrder: 0, isActive: true },
                ],
            });
            expect(subjectModel.find).toHaveBeenCalledWith({ isActive: true });
        });
    });

    describe('POST /study/items', () => {
        const add = (body: object) => request(app.getHttpServer()).post(api('/study/items')).set(AUTH).send(body);

        it('로그인하지 않으면 401', async () => {
            const res = await request(app.getHttpServer()).post(api('/study/items')).send({});
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
        });

        it('항목을 오늘 기록에 더하고 201로 돌려준다 (과목이 있으면 subjectId도 채운다)', async () => {
            subject = { _id: subjectId, name: '수학' };
            const res = await add({ title: '영어 단어', subjectName: '수학', goalMin: 30 });

            expect(res.status).toBe(201);
            expect(res.body).toEqual({
                data: {
                    _id: expect.any(String),
                    title: '영어 단어',
                    subjectId: subjectId.toString(),
                    subjectName: '수학',
                    goalMin: 30,
                    accumulatedSec: 0,
                },
            });
            expect(dailyModel.updateOne).toHaveBeenCalledWith(
                { userId: owner, studyDate: TODAY },
                { $push: { items: expect.objectContaining({ title: '영어 단어', subjectId, goalMin: 30, accumulatedSec: 0 }) } },
            );
        });

        it('목록에 없는 과목이면 subjectId는 null, 목표가 없으면 goalMin은 null', async () => {
            const res = await add({ title: '자유 공부', subjectName: '없는과목', goalMin: null });
            expect(res.status).toBe(201);
            expect(res.body.data).toMatchObject({ subjectId: null, subjectName: '없는과목', goalMin: null });
        });

        it('과목 이름이 빈 글자면 과목 없이 만든다', async () => {
            const res = await add({ title: '자유 공부', subjectName: '' });
            expect(res.status).toBe(201);
            expect(res.body.data.subjectId).toBeNull();
            expect(res.body.data.subjectName).toBeUndefined();
            expect(subjectModel.findOne).not.toHaveBeenCalled();
        });

        it('목표 시간은 1분 ~ 24시간(1440분)까지만 받는다', async () => {
            expect((await add({ title: 'a', subjectName: '수학', goalMin: 1440 })).status).toBe(201);
            expect((await add({ title: 'a', subjectName: '수학', goalMin: 1441 })).status).toBe(400);
        });

        it('제목이 비었거나 목표가 0이거나 모르는 필드가 있으면 400', async () => {
            expect((await add({ title: '', subjectName: '수학' })).status).toBe(400);
            expect((await add({ title: 'a', subjectName: '수학', goalMin: 0 })).status).toBe(400);
            expect((await add({ title: 'a', subjectName: '수학', extra: 1 })).status).toBe(400);
            expect(dailyModel.updateOne).not.toHaveBeenCalled();
        });
    });

    describe('POST /study-sessions', () => {
        const start = (body: object) => request(app.getHttpServer()).post(api('/study-sessions')).set(AUTH).send(body);

        it('로그인하지 않으면 401', async () => {
            const res = await request(app.getHttpServer()).post(api('/study-sessions')).send({});
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
        });

        it('세션을 만들고 201 { data }로 돌려준다', async () => {
            const res = await start({ studyItemId: itemId.toString(), mode: 'personal' });

            expect(res.status).toBe(201);
            expect(res.body.data).toEqual({
                _id: expect.any(String),
                studyDate: TODAY,
                studyItemId: itemId.toString(),
                roomId: null,
                mode: 'personal',
                status: 'running',
                startedAt: NOW.toISOString(),
                endedAt: null,
                durationSec: 0,
                departureCount: 0,
                endReason: null,
                isAbuse: false,
                pauses: [],
            });
            // 오늘 기록 안에 그 항목이 있는지 확인한 뒤 만든다
            expect(dailyModel.findOne).toHaveBeenCalledWith(
                { userId: owner, studyDate: TODAY, 'items._id': itemId },
                { _id: 1 },
            );
            expect(sessionModel.create).toHaveBeenCalledWith(
                [expect.objectContaining({ userId: owner, studyItemId: itemId, mode: 'personal', status: 'running' })],
                { session: tx },
            );
            // 열려 있던 세션이 없으면 정산할 것도 없다
            expect(sessionModel.find).toHaveBeenCalledWith(
                { userId: owner, status: { $ne: 'ended' } },
                null,
                { session: tx },
            );
            expect(sessionModel.updateOne).not.toHaveBeenCalled();
            expect(points.earn).not.toHaveBeenCalled();
        });

        it('이미 열려 있는 세션이 있으면 먼저 정산하며 닫고 새 세션을 만든다 (동시에 여러 세션 방지)', async () => {
            const oldId = new Types.ObjectId();
            // 11분 40초 전에 시작해 50초째 쉬는 중 → 순공 650초
            openRows = [
                makeRow({
                    _id: oldId,
                    status: 'paused',
                    startedAt: secondsAgo(700),
                    pauses: [{ startedAt: secondsAgo(50), endedAt: null, reason: 'manual' }],
                }),
            ];

            const res = await start({ studyItemId: itemId.toString(), mode: 'personal' });

            expect(res.status).toBe(201);
            expect(connection.transaction).toHaveBeenCalledTimes(1);
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: oldId, status: { $ne: 'ended' } },
                {
                    $set: expect.objectContaining({
                        status: 'ended',
                        endReason: 'replaced',
                        durationSec: 650,
                        pointsEarned: 20,
                    }),
                },
                expect.anything(),
            );
            expect(points.earn).toHaveBeenCalledWith(TEST_USER_ID, 20, 'session_complete', '순공 세션 완료', tx, {
                sessionId: oldId,
                studyDate: TODAY,
            });
            // 이전 세션을 닫은 다음에 새 세션을 만든다
            const closedAt = sessionModel.updateOne.mock.invocationCallOrder[0] ?? Infinity;
            const createdAt = sessionModel.create.mock.invocationCallOrder[0] ?? 0;
            expect(closedAt).toBeLessThan(createdAt);
        });

        it('동시 시작으로 중복 키 오류(11000)가 나면 트랜잭션을 한 번 다시 실행해 성공한다 (먼저 생긴 세션은 replaced로 정산)', async () => {
            const firstId = new Types.ObjectId();
            const leanOf = (rows: Record<string, unknown>[]) => ({ lean: vi.fn(() => Promise.resolve(rows)) });
            // 처음 실행에서는 열린 세션이 안 보이고, 다시 실행하면 동시에 시작한 세션이 보인다
            sessionModel.find
                .mockReturnValueOnce(leanOf([]))
                .mockReturnValueOnce(leanOf([makeRow({ _id: firstId, startedAt: secondsAgo(700) })]));
            sessionModel.create.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

            const res = await start({ studyItemId: itemId.toString(), mode: 'personal' });

            expect(res.status).toBe(201);
            expect(connection.transaction).toHaveBeenCalledTimes(2);
            expect(sessionModel.create).toHaveBeenCalledTimes(2);
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: firstId, status: { $ne: 'ended' } },
                { $set: expect.objectContaining({ status: 'ended', endReason: 'replaced' }) },
                expect.anything(),
            );
        });

        it('다시 실행해도 중복 키 오류가 나면 오류를 그대로 던진다 (두 번만 시도)', async () => {
            const duplicate = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
            sessionModel.create.mockRejectedValueOnce(duplicate()).mockRejectedValueOnce(duplicate());

            const res = await start({ studyItemId: itemId.toString(), mode: 'personal' });

            expect(res.status).toBe(500);
            expect(connection.transaction).toHaveBeenCalledTimes(2);
            expect(sessionModel.create).toHaveBeenCalledTimes(2);
        });

        it('오늘 기록에 없는 항목이면 404 { code, message }, 세션을 만들지 않는다', async () => {
            record = null;
            const res = await start({ studyItemId: new Types.ObjectId().toString(), mode: 'personal' });
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
            expect(sessionModel.create).not.toHaveBeenCalled();
            expect(connection.transaction).not.toHaveBeenCalled();
        });

        it('항목 ID 모양이 틀리거나 모드가 틀리면 400', async () => {
            expect((await start({ studyItemId: 'not-an-id', mode: 'personal' })).status).toBe(400);
            expect((await start({ studyItemId: itemId.toString(), mode: 'weird' })).status).toBe(400);
            expect(sessionModel.create).not.toHaveBeenCalled();
        });
    });

    describe('POST /study-sessions/:id/pause', () => {
        const pause = (id: string) => request(app.getHttpServer()).post(api(`/study-sessions/${id}/pause`)).set(AUTH);

        it('달리는 세션을 멈추고 204, 정지를 한 건 기록한다', async () => {
            const res = await pause(sessionId.toString());
            expect(res.status).toBe(204);
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: sessionId, status: 'running' },
                {
                    $set: { status: 'paused' },
                    $push: { pauses: { startedAt: NOW, endedAt: null, reason: 'manual' } },
                },
            );
        });

        it('이미 멈춘 세션이면 아무것도 바꾸지 않고 204', async () => {
            row = makeRow({ status: 'paused' });
            const res = await pause(sessionId.toString());
            expect(res.status).toBe(204);
            expect(sessionModel.updateOne).not.toHaveBeenCalled();
        });

        it('없는 세션이면 404, ID 모양이 틀리면 DB에 묻지 않고 404', async () => {
            row = null;
            const missing = await pause(new Types.ObjectId().toString());
            expect(missing.status).toBe(404);
            expect(missing.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });

            sessionModel.findOne.mockClear();
            const bad = await pause('not-an-id');
            expect(bad.status).toBe(404);
            expect(sessionModel.findOne).not.toHaveBeenCalled();
        });

        it('로그인하지 않으면 401', async () => {
            const res = await request(app.getHttpServer()).post(api(`/study-sessions/${sessionId.toString()}/pause`));
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
        });
    });

    describe('POST /study-sessions/:id/resume', () => {
        const resume = (id: string) => request(app.getHttpServer()).post(api(`/study-sessions/${id}/resume`)).set(AUTH);

        it('멈춘 세션을 다시 달리게 하고 204, 열려 있는 정지의 끝 시각을 채운다', async () => {
            row = makeRow({ status: 'paused', pauses: [{ startedAt: secondsAgo(30), endedAt: null, reason: 'manual' }] });
            const res = await resume(sessionId.toString());
            expect(res.status).toBe(204);
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: sessionId, status: 'paused' },
                { $set: { status: 'running', 'pauses.$[open].endedAt': NOW } },
                { arrayFilters: [{ 'open.endedAt': null }] },
            );
        });

        it('멈춰 있지 않은 세션이면 아무것도 바꾸지 않고 204', async () => {
            const res = await resume(sessionId.toString());
            expect(res.status).toBe(204);
            expect(sessionModel.updateOne).not.toHaveBeenCalled();
        });

        it('없는 세션이면 404', async () => {
            row = null;
            const res = await resume(new Types.ObjectId().toString());
            expect(res.status).toBe(404);
        });
    });

    describe('POST /study-sessions/:id/end', () => {
        const end = (id: string, body: object = { clientDurationSec: 0, endReason: 'manual' }) =>
            request(app.getHttpServer()).post(api(`/study-sessions/${id}/end`)).set(AUTH).send(body);

        it('로그인하지 않으면 401', async () => {
            const res = await request(app.getHttpServer())
                .post(api(`/study-sessions/${sessionId.toString()}/end`))
                .send({ clientDurationSec: 0, endReason: 'manual' });
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
        });

        it('10분 이상이면 서버가 계산한 시간으로 마감하고 30포인트를 같은 트랜잭션에서 적립한다', async () => {
            // 앱이 보낸 시간(1초)은 무시하고 서버 기록(700초)을 쓴다
            const res = await end(sessionId.toString(), { clientDurationSec: 1, endReason: 'manual' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ data: { durationSec: 700, pointsEarned: 20 } });
            expect(connection.transaction).toHaveBeenCalledTimes(1);
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: sessionId, status: { $ne: 'ended' } },
                {
                    $set: {
                        status: 'ended',
                        endedAt: NOW,
                        durationSec: 700,
                        isAbuse: false,
                        endReason: 'manual',
                        pointsEarned: 20,
                        'pauses.$[open].endedAt': NOW,
                    },
                },
                { arrayFilters: [{ 'open.endedAt': null }], session: tx },
            );
            expect(dailyModel.updateOne).toHaveBeenCalledWith(
                { userId: owner, studyDate: TODAY },
                {
                    $inc: { totalSec: 700, personalSec: 700, 'items.$[item].accumulatedSec': 700 },
                    $set: { streakOk: true }, // 합계가 10분을 넘으면 연속 공부일로 친다
                },
                { arrayFilters: [{ 'item._id': itemId }], session: tx },
            );
            expect(points.earn).toHaveBeenCalledWith(TEST_USER_ID, 20, 'session_complete', '순공 세션 완료', tx, {
                sessionId,
                studyDate: TODAY,
            });
        });

        it('일시정지한 시간은 빼고 센다 (끝난 정지 + 아직 열려 있는 정지)', async () => {
            row = makeRow({
                startedAt: secondsAgo(1000),
                pauses: [
                    { startedAt: secondsAgo(600), endedAt: secondsAgo(480), reason: 'manual' }, // 120초
                    { startedAt: secondsAgo(100), endedAt: null, reason: 'manual' }, // 지금까지 100초
                ],
            });
            const res = await end(sessionId.toString());
            // 1000 - 120 - 100 = 780
            expect(res.body).toEqual({ data: { durationSec: 780, pointsEarned: 20 } });
        });

        it('오늘 세션 보상을 이미 2번 받았다면 시간은 쌓되 포인트는 주지 않는다 (하루 2번까지)', async () => {
            points.countEarned.mockResolvedValueOnce(2);

            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 700, pointsEarned: 0 } });
            expect(points.countEarned).toHaveBeenCalledWith(TEST_USER_ID, 'session_complete', TODAY, tx);
            expect(points.earn).not.toHaveBeenCalled();
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: sessionId, status: { $ne: 'ended' } },
                { $set: expect.objectContaining({ status: 'ended', durationSec: 700, pointsEarned: 0 }) },
                expect.anything(),
            );
        });

        it('오늘 1번 받았다면 두 번째 보상은 준다', async () => {
            points.countEarned.mockResolvedValueOnce(1);

            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 700, pointsEarned: 20 } });
            expect(points.earn).toHaveBeenCalledWith(TEST_USER_ID, 20, 'session_complete', '순공 세션 완료', tx, {
                sessionId,
                studyDate: TODAY,
            });
        });

        it('10분이 안 되면 보상 횟수를 세지도 않는다', async () => {
            row = makeRow({ startedAt: secondsAgo(599) });

            await end(sessionId.toString());

            expect(points.countEarned).not.toHaveBeenCalled();
        });

        it('정확히 600초면 적립하고, 599초면 적립하지 않는다', async () => {
            row = makeRow({ startedAt: secondsAgo(600) });
            expect((await end(sessionId.toString())).body).toEqual({ data: { durationSec: 600, pointsEarned: 20 } });

            points.earn.mockClear();
            row = makeRow({ startedAt: secondsAgo(599) });
            const short = await end(sessionId.toString());
            expect(short.body).toEqual({ data: { durationSec: 599, pointsEarned: 0 } });
            expect(points.earn).not.toHaveBeenCalled();
            // 포인트는 없어도 공부한 시간은 하루 기록에 쌓인다
            expect(dailyModel.updateOne).toHaveBeenLastCalledWith(
                { userId: owner, studyDate: TODAY },
                {
                    $inc: { totalSec: 599, personalSec: 599, 'items.$[item].accumulatedSec': 599 },
                    $set: { streakOk: true },
                },
                expect.anything(),
            );
        });

        it('방 세션이면 roomSec에 쌓인다', async () => {
            row = makeRow({ mode: 'room' });
            await end(sessionId.toString());
            expect(dailyModel.updateOne).toHaveBeenCalledWith(
                expect.anything(),
                {
                    $inc: { totalSec: 700, roomSec: 700, 'items.$[item].accumulatedSec': 700 },
                    $set: { streakOk: true },
                },
                expect.anything(),
            );
        });

        it('자정을 넘긴 세션은 날짜별로 나눠 쌓고, 시작한 날 항목에만 쌓는다 (FR-06-14)', async () => {
            // 서울 2026-11-04 23:30에 시작해 11-05 00:10에 끝남 → 1800초 + 600초
            vi.setSystemTime(new Date('2026-11-04T15:10:00.000Z'));
            row = makeRow({ startedAt: new Date('2026-11-04T14:30:00.000Z') });
            // 공부 항목에 과목이 있다 → 두 날 모두 과목별 시간(subjectSec)에도 쌓는다
            const mathId = new Types.ObjectId();
            const subjectKey = `subjectSec.${mathId.toString()}`;
            const withSubject = {
                ...makeRecord(),
                items: [{ _id: itemId, title: '수학 문제집', subjectId: mathId, subjectName: '수학', goalMin: 60, accumulatedSec: 600 }],
            };
            const lean = (value: Record<string, unknown> | null) => ({ lean: vi.fn(() => Promise.resolve(value)) });
            dailyModel.findOne.mockImplementationOnce(() => lean(withSubject)); // 시작한 날 항목의 과목 (정산할 때 한 번만 찾는다)
            dailyModel.findOne.mockImplementationOnce(() => lean(record)); // 11-04 (이미 600초)
            dailyModel.findOne.mockImplementationOnce(() => lean(null)); // 11-05 (아직 기록 없음)

            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 2400, pointsEarned: 20 } });
            expect(dailyModel.findOne).toHaveBeenNthCalledWith(
                1,
                { userId: owner, studyDate: TODAY, 'items._id': itemId },
                { 'items.$': 1 },
                { session: tx },
            );
            expect(dailyModel.updateOne).toHaveBeenNthCalledWith(
                1,
                { userId: owner, studyDate: '2026-11-04' },
                {
                    $inc: { totalSec: 1800, personalSec: 1800, 'items.$[item].accumulatedSec': 1800, [subjectKey]: 1800 },
                    $set: { streakOk: true },
                },
                { arrayFilters: [{ 'item._id': itemId }], session: tx },
            );
            expect(dailyModel.updateOne).toHaveBeenNthCalledWith(
                2,
                { userId: owner, studyDate: '2026-11-05' },
                {
                    $inc: { totalSec: 600, personalSec: 600, [subjectKey]: 600 }, // 항목에는 안 쌓아도 과목 시간은 다음 날 몫도 쌓는다
                    $set: { streakOk: true },
                    $setOnInsert: { items: [] },
                },
                { upsert: true, session: tx },
            );
        });

        it('자정을 넘긴 세션의 보상은 끝낸 날(서울) 기준으로 횟수를 세고 장부에 적는다', async () => {
            // 서울 11-04 23:50에 시작해 11-05 00:30에 끝남. 시작일은 11-04, 끝낸 날은 11-05
            vi.setSystemTime(new Date('2026-11-04T15:30:00.000Z'));
            row = makeRow({ startedAt: new Date('2026-11-04T14:50:00.000Z') });

            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 2400, pointsEarned: 20 } });
            expect(points.countEarned).toHaveBeenCalledWith(TEST_USER_ID, 'session_complete', '2026-11-05', tx);
            expect(points.earn).toHaveBeenCalledWith(TEST_USER_ID, 20, 'session_complete', '순공 세션 완료', tx, {
                sessionId,
                studyDate: '2026-11-05',
            });
            // 보상 날짜의 하루 기록을 트랜잭션 안에서 한 번 쓴다 (동시 종료 충돌용)
            expect(dailyModel.updateOne).toHaveBeenCalledWith(
                { userId: owner, studyDate: '2026-11-05' },
                {
                    $set: { updatedAt: new Date('2026-11-04T15:30:00.000Z') },
                    $setOnInsert: { totalSec: 0, personalSec: 0, roomSec: 0, streakOk: false, items: [] },
                },
                { upsert: true, session: tx },
            );
        });

        it('끝낸 날(서울)에 이미 2번 받았다면 자정을 넘긴 세션도 0P', async () => {
            vi.setSystemTime(new Date('2026-11-04T15:30:00.000Z')); // 서울 11-05 00:30
            row = makeRow({ startedAt: new Date('2026-11-04T14:50:00.000Z') }); // 시작일은 11-04
            // 끝낸 날(11-05)에 이미 2번 받았고, 시작일(11-04)에는 0번
            points.countEarned.mockImplementation((_user: string, _reason: string, date: string) =>
                Promise.resolve(date === '2026-11-05' ? 2 : 0),
            );

            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 2400, pointsEarned: 0 } });
            expect(points.countEarned).toHaveBeenCalledWith(TEST_USER_ID, 'session_complete', '2026-11-05', tx);
            expect(points.earn).not.toHaveBeenCalled();
            points.countEarned.mockReset().mockResolvedValue(0);
        });

        it('하루 16시간을 넘는 부분은 세지 않는다 (FR-06-15)', async () => {
            // 이미 15시간 쌓인 날에 2시간 공부 → 1시간만 센다
            record = { ...makeRecord(), totalSec: 15 * 3600, streakOk: true };
            row = makeRow({ startedAt: secondsAgo(7200) });
            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 3600, pointsEarned: 20 } });
            expect(dailyModel.updateOne).toHaveBeenCalledWith(
                { userId: owner, studyDate: TODAY },
                { $inc: { totalSec: 3600, personalSec: 3600, 'items.$[item].accumulatedSec': 3600 } },
                expect.anything(),
            );
        });

        it('이미 16시간을 채운 날이면 쌓지도 포인트를 주지도 않는다', async () => {
            record = { ...makeRecord(), totalSec: 16 * 3600, streakOk: true };
            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 0, pointsEarned: 0 } });
            expect(dailyModel.updateOne).not.toHaveBeenCalled();
            expect(points.earn).not.toHaveBeenCalled();
        });

        it('24시간 이상 이어진 세션은 어뷰징으로 표시하고 하루 기록·포인트에서 뺀다 (FR-06-16)', async () => {
            row = makeRow({ startedAt: secondsAgo(24 * 3600) });
            const res = await end(sessionId.toString());

            expect(res.body).toEqual({ data: { durationSec: 0, pointsEarned: 0 } });
            // 세션은 지우지 않고 isAbuse만 표시한다
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: sessionId, status: { $ne: 'ended' } },
                { $set: expect.objectContaining({ status: 'ended', isAbuse: true, durationSec: 0, pointsEarned: 0 }) },
                expect.anything(),
            );
            expect(dailyModel.updateOne).not.toHaveBeenCalled();
            expect(points.earn).not.toHaveBeenCalled();
        });

        it('방치 판정은 날짜별 버림 전 전체 시간으로 한다: 서울 12:00:00.500부터 정확히 24시간이면 방치, 1초 모자라면 아니다', async () => {
            // 날짜별로 따로 버리면 (43199 + 43200 = 86399초) 정확히 24시간인데도 방치로 안 잡힌다
            vi.setSystemTime(new Date('2026-11-05T03:00:00.500Z')); // 서울 다음 날 12:00:00.500
            row = makeRow({ startedAt: new Date('2026-11-04T03:00:00.500Z') }); // 서울 12:00:00.500
            const abuse = await end(sessionId.toString());

            expect(abuse.body).toEqual({ data: { durationSec: 0, pointsEarned: 0 } });
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: sessionId, status: { $ne: 'ended' } },
                { $set: expect.objectContaining({ isAbuse: true, durationSec: 0, pointsEarned: 0 }) },
                expect.anything(),
            );
            expect(dailyModel.updateOne).not.toHaveBeenCalled();
            expect(points.earn).not.toHaveBeenCalled();

            vi.clearAllMocks();
            row = makeRow({ startedAt: new Date('2026-11-04T03:00:01.500Z') }); // 24시간에서 1초 모자람
            const normal = await end(sessionId.toString());

            expect(normal.body.data.durationSec).toBeGreaterThan(0);
            expect(normal.body.data.pointsEarned).toBe(20);
            expect(sessionModel.updateOne).toHaveBeenCalledWith(
                { _id: sessionId, status: { $ne: 'ended' } },
                { $set: expect.objectContaining({ isAbuse: false }) },
                expect.anything(),
            );
            expect(points.earn).toHaveBeenCalledTimes(1);
        });

        it('이미 끝난 세션이면 처음 결과를 그대로 돌려주고 아무것도 다시 쓰지 않는다 (중복 적립 없음)', async () => {
            row = makeRow({ status: 'ended', endedAt: secondsAgo(10), durationSec: 690, pointsEarned: 20 });
            const res = await end(sessionId.toString());

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ data: { durationSec: 690, pointsEarned: 20 } });
            expect(sessionModel.updateOne).not.toHaveBeenCalled();
            expect(dailyModel.updateOne).not.toHaveBeenCalled();
            expect(points.earn).not.toHaveBeenCalled();
        });

        it('시간이 0초면 하루 기록을 건드리지 않는다', async () => {
            row = makeRow({ startedAt: NOW });
            const res = await end(sessionId.toString());
            expect(res.body).toEqual({ data: { durationSec: 0, pointsEarned: 0 } });
            expect(dailyModel.updateOne).not.toHaveBeenCalled();
        });

        it('없는 세션이면 404, ID 모양이 틀리면 트랜잭션도 열지 않고 404', async () => {
            row = null;
            const missing = await end(new Types.ObjectId().toString());
            expect(missing.status).toBe(404);
            expect(missing.body).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });

            connection.transaction.mockClear();
            const bad = await end('not-an-id');
            expect(bad.status).toBe(404);
            expect(connection.transaction).not.toHaveBeenCalled();
        });

        it('본문이 틀리면 400', async () => {
            expect((await end(sessionId.toString(), { endReason: 'manual' })).status).toBe(400);
            expect((await end(sessionId.toString(), { clientDurationSec: -1, endReason: 'manual' })).status).toBe(400);
            expect((await end(sessionId.toString(), { clientDurationSec: 0, endReason: 'a', extra: 1 })).status).toBe(400);
            expect(connection.transaction).not.toHaveBeenCalled();
        });
    });
});
