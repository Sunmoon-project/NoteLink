import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Connection, Model, Types } from 'mongoose';

import { User, type UserDocument } from '../../auth/schemas/user.schema.js';

import type { LedgerType } from '../dto/list-point-ledger.dto.js';
import { PointLedger, type PointReasonType } from '../schemas/point-ledger.schema.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** 앱에 내려주는 포인트 내역 한 건 (공유 계약 PointLedger와 같은 모양) */
export interface PointLedgerView {
    _id: string;
    amount: number;
    balanceAfter: number;
    reasonType: PointReasonType;
    description: string | null;
    createdAt: string;
}

type PointLedgerLean = PointLedger & { _id: Types.ObjectId; createdAt: Date };

/** 적립이 어떤 일로 생겼는지 장부에 남기는 선택 정보 (하루 한도를 셀 때 쓴다) */
export interface EarnRef {
    sessionId?: Types.ObjectId;
    studyDate?: string; // 서울 기준 'YYYY-MM-DD'
}

export interface ListLedgerOptions {
    type?: LedgerType;
    cursor?: string;
    limit?: string;
}

@Injectable()
export class PointService {
    constructor(
        @InjectModel(PointLedger.name) private readonly ledgerModel: Model<PointLedger>,
        @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
        @InjectConnection() private readonly connection: Connection,
    ) { }

    /** 내 포인트 내역, 최신순 */
    async listLedger(userId: string, options: ListLedgerOptions = {}): Promise<PointLedgerView[]> {
        const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };

        // 적립은 amount > 0, 사용은 amount < 0
        if (options.type === 'earn') filter.amount = { $gt: 0 };
        if (options.type === 'spend') filter.amount = { $lt: 0 };

        // 커서가 있으면 그 항목보다 오래된 것부터 (_id는 만들어진 순서대로 커진다)
        if (options.cursor) filter._id = { $lt: new Types.ObjectId(options.cursor) };

        const requested = options.limit === undefined ? DEFAULT_LIMIT : Number(options.limit);
        const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);

        const docs = await this.ledgerModel
            .find(filter)
            .sort({ _id: -1 })
            .limit(limit)
            .lean<PointLedgerLean[]>();
        return docs.map(toLedgerView);
    }

    /**
     * 포인트 사용: 잔액을 줄이고 장부에 한 줄 남긴다. 줄인 뒤의 잔액을 돌려준다.
     * 여러 쓰기를 한 묶음으로 처리하려고 호출하는 쪽(예: 구매)의 트랜잭션 session을 받는다.
     * 잔액이 모자라면 아무것도 바꾸지 않고 POINTS_INSUFFICIENT
     */
    async spend(
        userId: string,
        amount: number,
        reasonType: PointReasonType,
        description: string | null,
        session: ClientSession,
    ): Promise<number> {
        const owner = new Types.ObjectId(userId);

        // "잔액 >= amount"일 때만 줄인다 → 읽고 나서 빼는 사이에 다른 요청이 끼어도 음수가 되지 않음
        const user = await this.userModel
            .findOneAndUpdate(
                { _id: owner, pointBalance: { $gte: amount } },
                { $inc: { pointBalance: -amount } },
                { returnDocument: 'after', session },
            )
            .lean<{ pointBalance: number }>();
        if (!user) {
            throw new BadRequestException({
                code: 'POINTS_INSUFFICIENT',
                message: '포인트가 부족합니다.',
            });
        }

        // 0포인트(무료 아이템)는 장부에 남길 변화가 없다
        if (amount > 0) {
            await this.ledgerModel.create(
                [{ userId: owner, amount: -amount, balanceAfter: user.pointBalance, reasonType, description }],
                { session },
            );
        }
        return user.pointBalance;
    }

    /**
     * 포인트 적립: 잔액을 늘리고 장부에 한 줄 남긴다. 늘린 뒤의 잔액을 돌려준다.
     * - 다른 작업(예: 세션 종료)과 한 묶음으로 처리하려면 그 트랜잭션의 session을 넘긴다.
     * - session을 안 넘기면 여기서 트랜잭션을 열어 "잔액 + 장부"가 함께 반영되거나 함께 취소된다.
     * 같은 일로 두 번 적립되지 않게 막는 건 호출하는 쪽의 몫이다 (예: 이미 끝난 세션이면 다시 부르지 않기)
     */
    async earn(
        userId: string,
        amount: number,
        reasonType: PointReasonType,
        description: string | null,
        session?: ClientSession,
        ref?: EarnRef,
    ): Promise<number> {
        // 서버 안에서 부르는 함수라서, 잘못된 값은 요청 오류(400)가 아니라 코드의 버그로 본다
        if (!Number.isInteger(amount) || amount <= 0) {
            throw new RangeError(`적립 포인트는 1 이상의 정수여야 합니다: ${amount}`);
        }
        if (session) return this.applyEarn(userId, amount, reasonType, description, session, ref);
        return this.connection.transaction((own) => this.applyEarn(userId, amount, reasonType, description, own, ref));
    }

    private async applyEarn(
        userId: string,
        amount: number,
        reasonType: PointReasonType,
        description: string | null,
        session: ClientSession,
        ref?: EarnRef,
    ): Promise<number> {
        const owner = new Types.ObjectId(userId);

        // $inc는 읽고 더하는 사이에 다른 요청이 끼어도 값이 어긋나지 않는다
        const user = await this.userModel
            .findOneAndUpdate({ _id: owner }, { $inc: { pointBalance: amount } }, { returnDocument: 'after', session })
            .lean<{ pointBalance: number }>();
        if (!user) {
            throw new NotFoundException({ code: 'NOT_FOUND', message: '존재하지 않는 사용자입니다.' });
        }

        await this.ledgerModel.create(
            [{ userId: owner, amount, balanceAfter: user.pointBalance, reasonType, description, ...ref }],
            { session },
        );
        return user.pointBalance;
    }

    /**
     * 그 날짜(서울 기준)에 이 이유로 적립받은 횟수. 하루 적립 한도를 확인할 때 쓴다.
     * 한도를 넘는 적립을 막으려면 적립과 같은 트랜잭션의 session을 넘긴다
     */
    countEarned(userId: string, reasonType: PointReasonType, studyDate: string, session: ClientSession): Promise<number> {
        return this.ledgerModel
            .countDocuments({ userId: new Types.ObjectId(userId), reasonType, studyDate }, { session })
            .exec();
    }
}

/** DB 문서 → 앱 응답 모양 */
function toLedgerView(doc: PointLedgerLean): PointLedgerView {
    return {
        _id: doc._id.toString(),
        amount: doc.amount,
        balanceAfter: doc.balanceAfter,
        reasonType: doc.reasonType,
        description: doc.description,
        createdAt: doc.createdAt.toISOString(),
    };
}