import { NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const ledgerModel = { create: vi.fn().mockResolvedValue([]), countDocuments: vi.fn(() => countQuery) };
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

    // 잔액 롤백은 DB 트랜잭션이 보장한다(실제 DB에서 확인)
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
