import { NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { User } from '../src/modules/auth/schemas/user.schema.js';
import { quizReward, sessionReward } from '../src/modules/reward/point/point-rules.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { PointLedger } from '../src/modules/reward/schemas/point-ledger.schema.js';

const userId = new Types.ObjectId();
// 트랜잭션의 가짜 session. 모든 쓰기에 이 session이 따라가는지 확인한다
const outer = { id: 'outer-session' };
const own = { id: 'own-session' };

let balance = 100;
let userExists = true;

const userModel = {
    findOneAndUpdate: vi.fn((_filter: unknown, update: { $inc: { pointBalance: number } }) => ({
        lean: vi.fn(() => {
            if (!userExists) return Promise.resolve(null);
            balance += update.$inc.pointBalance;
            return Promise.resolve({ pointBalance: balance });
        }),
    })),
};
const countQuery = { exec: vi.fn().mockResolvedValue(1) };
const sumQuery = { exec: vi.fn().mockResolvedValue([] as { total: number }[]) };
const ledgerModel = {
    create: vi.fn().mockResolvedValue([]),
    countDocuments: vi.fn(() => countQuery),
    aggregate: vi.fn((..._args: unknown[]) => sumQuery),
};
const connection = {
    transaction: vi.fn((work: (s: typeof own) => Promise<unknown>) => work(own)),
};

describe('PointService.earn', () => {
    let points: PointService;

    beforeEach(async () => {
        vi.clearAllMocks();
        balance = 100;
        userExists = true;
        const moduleRef = await Test.createTestingModule({
            providers: [
                PointService,
                { provide: getModelToken(PointLedger.name), useValue: ledgerModel },
                { provide: getModelToken(User.name), useValue: userModel },
                { provide: getConnectionToken(), useValue: connection },
            ],
        }).compile();
        points = moduleRef.get(PointService);
    });

    it('session을 넘기면 그 트랜잭션에 끼어서 잔액을 늘리고 장부에 양수로 남긴다', async () => {
        const result = await points.earn(userId.toString(), 30, 'session_complete', '순공 세션 완료', outer as never);

        expect(result).toBe(130);
        expect(connection.transaction).not.toHaveBeenCalled();
        expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: userId },
            { $inc: { pointBalance: 30 } },
            { returnDocument: 'after', session: outer },
        );
        expect(ledgerModel.create).toHaveBeenCalledWith(
            [{ userId, amount: 30, balanceAfter: 130, reasonType: 'session_complete', description: '순공 세션 완료' }],
            { session: outer },
        );
    });

    it('session을 안 넘기면 스스로 트랜잭션을 열고, 잔액과 장부가 같은 session을 쓴다', async () => {
        const result = await points.earn(userId.toString(), 120, 'quiz_correct', null);

        expect(result).toBe(220);
        expect(connection.transaction).toHaveBeenCalledTimes(1);
        expect(userModel.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: userId },
            { $inc: { pointBalance: 120 } },
            { returnDocument: 'after', session: own },
        );
        expect(ledgerModel.create).toHaveBeenCalledWith(
            [{ userId, amount: 120, balanceAfter: 220, reasonType: 'quiz_correct', description: null }],
            { session: own },
        );
    });

    it('ref를 넘기면 어떤 세션 · 어느 날의 적립인지 장부에 함께 남긴다', async () => {
        const sessionId = new Types.ObjectId();

        await points.earn(userId.toString(), 20, 'session_complete', '순공 세션 완료', outer as never, {
            sessionId,
            studyDate: '2026-11-09',
        });

        expect(ledgerModel.create).toHaveBeenCalledWith(
            [
                {
                    userId,
                    amount: 20,
                    balanceAfter: 120,
                    reasonType: 'session_complete',
                    description: '순공 세션 완료',
                    sessionId,
                    studyDate: '2026-11-09',
                },
            ],
            { session: outer },
        );
    });

    it('countEarned는 그 사용자 · 이유 · 날짜의 장부 개수를 같은 트랜잭션에서 센다', async () => {
        countQuery.exec.mockResolvedValueOnce(2);

        const count = await points.countEarned(userId.toString(), 'session_complete', '2026-11-09', outer as never);

        expect(count).toBe(2);
        expect(ledgerModel.countDocuments).toHaveBeenCalledWith(
            { userId, reasonType: 'session_complete', studyDate: '2026-11-09' },
            { session: outer },
        );
    });

    it('없는 사용자면 NOT_FOUND이고 장부에는 아무것도 남기지 않는다', async () => {
        userExists = false;
        const error = await points.earn(userId.toString(), 30, 'mission', null).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).getResponse()).toEqual({ code: 'NOT_FOUND', message: expect.any(String) });
        expect(ledgerModel.create).not.toHaveBeenCalled();
    });

    // 잔액 롤백은 point-earn-real-db.test.ts에서 실제 DB로 확인한다
    it('장부 저장 실패 시 오류를 그대로 던진다', async () => {
        ledgerModel.create.mockRejectedValueOnce(new Error('ledger down'));
        await expect(points.earn(userId.toString(), 30, 'admin', null)).rejects.toThrow('ledger down');
    });

    it.each([0, -5, 1.5, Number.NaN])('적립 포인트가 %s이면 DB를 건드리지 않고 거부한다', async (amount) => {
        await expect(points.earn(userId.toString(), amount, 'admin', null)).rejects.toThrow(RangeError);
        expect(connection.transaction).not.toHaveBeenCalled();
        expect(userModel.findOneAndUpdate).not.toHaveBeenCalled();
        expect(ledgerModel.create).not.toHaveBeenCalled();
    });
});

describe('PointService.sumEarned · earnQuiz', () => {
    let points: PointService;

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.useRealTimers();
        balance = 100;
        userExists = true;
        sumQuery.exec.mockResolvedValue([]);
        const moduleRef = await Test.createTestingModule({
            providers: [
                PointService,
                { provide: getModelToken(PointLedger.name), useValue: ledgerModel },
                { provide: getModelToken(User.name), useValue: userModel },
                { provide: getConnectionToken(), useValue: connection },
            ],
        }).compile();
        points = moduleRef.get(PointService);
        // 서울 2026-11-10 낮 12시
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-10T03:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sumEarned는 그 사용자 · 이유 · 날짜의 amount 합계를 같은 트랜잭션에서 구한다', async () => {
        sumQuery.exec.mockResolvedValueOnce([{ total: 28 }]);

        const sum = await points.sumEarned(userId.toString(), 'quiz_correct', '2026-11-10', outer as never);

        expect(sum).toBe(28);
        expect(ledgerModel.aggregate).toHaveBeenCalledWith(
            [
                { $match: { userId, reasonType: 'quiz_correct', studyDate: '2026-11-10' } },
                { $group: { _id: null, total: { $sum: '$amount' } } },
            ],
            { session: outer },
        );
    });

    it('sumEarned는 장부가 없으면 0이다', async () => {
        expect(await points.sumEarned(userId.toString(), 'quiz_correct', '2026-11-10')).toBe(0);
    });

    it('정답 7개(28P)는 오늘 받은 게 없으면 28P를 준다', async () => {
        const result = await points.earnQuiz(userId.toString(), 7, outer as never);

        expect(result).toBe(28);
        expect(balance).toBe(128);
    });

    it('이미 28P를 받았으면 정답 10개(40P)도 12P만 준다', async () => {
        sumQuery.exec.mockResolvedValueOnce([{ total: 28 }]);

        expect(await points.earnQuiz(userId.toString(), 10, outer as never)).toBe(12);
        expect(balance).toBe(112);
    });

    it('이미 40P를 받았으면 0P이고 earn을 부르지 않는다', async () => {
        sumQuery.exec.mockResolvedValueOnce([{ total: 40 }]);
        const earnSpy = vi.spyOn(points, 'earn');

        expect(await points.earnQuiz(userId.toString(), 5, outer as never)).toBe(0);
        expect(earnSpy).not.toHaveBeenCalled();
        expect(ledgerModel.create).not.toHaveBeenCalled();
    });

    it('한도를 넘겨 받은 기록이 있어도 음수로 계산하지 않고 0P', async () => {
        sumQuery.exec.mockResolvedValueOnce([{ total: 52 }]);
        expect(await points.earnQuiz(userId.toString(), 5, outer as never)).toBe(0);
    });

    it('정답 0개면 0P이고 earn을 부르지 않는다', async () => {
        const earnSpy = vi.spyOn(points, 'earn');

        expect(await points.earnQuiz(userId.toString(), 0, outer as never)).toBe(0);
        expect(earnSpy).not.toHaveBeenCalled();
    });

    it('earn에 quiz_correct · 설명 · 서울 날짜(studyDate) · 같은 tx가 넘어간다', async () => {
        const earnSpy = vi.spyOn(points, 'earn');

        await points.earnQuiz(userId.toString(), 3, outer as never);

        expect(earnSpy).toHaveBeenCalledWith(userId.toString(), 12, 'quiz_correct', '퀴즈 정답 3개', outer, {
            studyDate: '2026-11-10',
        });
    });

    it('session을 안 넘기면 스스로 트랜잭션을 열고 합계 조회와 적립이 같은 session을 쓴다', async () => {
        const result = await points.earnQuiz(userId.toString(), 2);

        expect(result).toBe(8);
        expect(connection.transaction).toHaveBeenCalledTimes(1);
        expect(ledgerModel.aggregate).toHaveBeenCalledWith(expect.anything(), { session: own });
        expect(ledgerModel.create).toHaveBeenCalledWith(expect.anything(), { session: own });
    });

    it('서울 자정을 넘기면 날짜가 바뀌어 다음 날 한도로 센다', async () => {
        const earnSpy = vi.spyOn(points, 'earn');

        // 서울 2026-11-10 23:59 (UTC 14:59)
        vi.setSystemTime(new Date('2026-11-10T14:59:00Z'));
        await points.earnQuiz(userId.toString(), 1, outer as never);
        // 서울 2026-11-11 00:01 (UTC 15:01)
        vi.setSystemTime(new Date('2026-11-10T15:01:00Z'));
        await points.earnQuiz(userId.toString(), 1, outer as never);

        expect(earnSpy.mock.calls[0]?.[5]).toEqual({ studyDate: '2026-11-10' });
        expect(earnSpy.mock.calls[1]?.[5]).toEqual({ studyDate: '2026-11-11' });
        expect(ledgerModel.aggregate.mock.calls[1]?.[0]).toEqual([
            { $match: { userId, reasonType: 'quiz_correct', studyDate: '2026-11-11' } },
            expect.anything(),
        ]);
    });
});

describe('적립 규칙', () => {
    it('순공 10분(600초) 미만이면 적립이 없고, 10분 이상이면 20포인트', () => {
        expect(sessionReward(599)).toBeUndefined();
        expect(sessionReward(600)).toEqual({ amount: 20, reasonType: 'session_complete', description: '순공 세션 완료' });
        expect(sessionReward(3600)?.amount).toBe(20);
    });

    it('시간이 NaN · Infinity · -Infinity면 적립이 없다', () => {
        expect(sessionReward(Number.NaN)).toBeUndefined();
        expect(sessionReward(Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(sessionReward(Number.NEGATIVE_INFINITY)).toBeUndefined();
    });

    it('퀴즈는 정답 하나당 4포인트이고, 맞힌 게 없으면 적립이 없다', () => {
        expect(quizReward(0)).toBeUndefined();
        expect(quizReward(-1)).toBeUndefined();
        expect(quizReward(5)).toEqual({ amount: 20, reasonType: 'quiz_correct', description: '퀴즈 정답 5개' });
    });
});
