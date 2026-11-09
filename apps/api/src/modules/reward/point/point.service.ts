import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

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