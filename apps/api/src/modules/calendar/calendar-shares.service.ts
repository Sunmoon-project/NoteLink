import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { DailyRecord } from '../progress/schemas/daily-record.schema.js';
import { daysBetween } from '../progress/week.js';
import { DEFAULT_SHARE_SCOPES, type CreateCalendarShareDto } from './dto/calendar-share.dto.js';
import { CalendarShare } from './schemas/calendar-share.schema.js';
import { Todo } from './schemas/todo.schema.js';

/** 앱에 내려주는 공유 링크 (공유 계약 CalendarShare) */
export interface CalendarShareView {
    _id: string;
    token: string;
    ownerId: string;
    ownerNickname?: string;
    rangeStart: string;
    rangeEnd: string;
    scopes: string[];
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    subscribers: { userId: string; addedAt: string }[];
}

type ShareLean = CalendarShare & { _id: Types.ObjectId; createdAt: Date };

const MAX_RANGE_DAYS = 366; // 한 번에 1년까지만 공유한다
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_BASE_URL = 'notelink.app/share';
const NOT_FOUND = { code: 'NOT_FOUND', message: '존재하지 않거나 취소된 공유 링크입니다.' };

@Injectable()
export class CalendarSharesService {
    constructor(
        @InjectModel(CalendarShare.name) private readonly shareModel: Model<CalendarShare>,
        @InjectModel(Todo.name) private readonly todoModel: Model<Todo>,
        @InjectModel(DailyRecord.name) private readonly dailyModel: Model<DailyRecord>,
        @InjectModel(User.name) private readonly userModel: Model<User>,
        private readonly config: ConfigService,
    ) { }

    /** 공유 링크를 만든다. 링크 주소는 토큰으로 만든다 */
    async create(userId: string, dto: CreateCalendarShareDto, now = new Date()): Promise<CalendarShareView & { url: string }> {
        if (dto.rangeEnd < dto.rangeStart || daysBetween(dto.rangeStart, dto.rangeEnd) + 1 > MAX_RANGE_DAYS) {
            throw new BadRequestException({
                code: 'VALIDATION_ERROR',
                message: `공유 기간은 시작일부터 종료일까지 최대 ${MAX_RANGE_DAYS}일이어야 합니다.`,
            });
        }
        const created = await this.shareModel.create({
            ownerId: new Types.ObjectId(userId),
            token: randomBytes(16).toString('hex'), // 추측하기 어려운 32자리 무작위 값
            rangeStart: dto.rangeStart,
            rangeEnd: dto.rangeEnd,
            scopes: dto.scopes ?? [...DEFAULT_SHARE_SCOPES],
            expiresAt: dto.expiresInDays === null ? null : new Date(now.getTime() + dto.expiresInDays * DAY_MS),
            revokedAt: null,
            subscribers: [],
            // 스키마 타입이 expiresAt · revokedAt에 null을 적지 않았지만 기본값은 null이라(무제한 · 취소 안 함) 그대로 저장한다
        } as unknown as Partial<CalendarShare>);
        const view = toView(created.toObject() as unknown as ShareLean, true);
        const base = this.config.get<string>('SHARE_BASE_URL') ?? DEFAULT_BASE_URL;
        return { ...view, url: `${base}/${view.token}` };
    }

    /** 내가 만든 링크 (취소한 것 제외, 최신순). 만료된 것도 만료일과 함께 보인다 */
    async list(userId: string): Promise<CalendarShareView[]> {
        const docs = await this.shareModel
            .find({ ownerId: new Types.ObjectId(userId), revokedAt: null })
            .sort({ createdAt: -1, _id: -1 })
            .lean<ShareLean[]>();
        return docs.map((d) => toView(d, true));
    }

    /** 링크를 취소한다. 내 것이 아니거나 없거나 이미 취소했으면 404 */
    async revoke(userId: string, id: string, now = new Date()): Promise<void> {
        if (!Types.ObjectId.isValid(id)) throw new NotFoundException(NOT_FOUND);
        const done = await this.shareModel.updateOne(
            { _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(userId), revokedAt: null },
            { $set: { revokedAt: now } },
        );
        if (done.matchedCount === 0) throw new NotFoundException(NOT_FOUND);
    }

    /**
     * 링크(토큰 또는 공유 id)로 받은 캘린더를 내 캘린더에 담는다.
     * 이미 담았거나 내 링크면 아무 일도 하지 않고 성공한다. 없거나 취소된 링크는 404, 만료된 링크는 410
     */
    async subscribe(userId: string, key: string, now = new Date()): Promise<void> {
        const share = await this.findByKey(key);
        if (!share || share.revokedAt) throw new NotFoundException(NOT_FOUND);
        if (share.expiresAt && share.expiresAt <= now) {
            throw new GoneException({ code: 'SHARE_EXPIRED', message: '유효기간이 지난 공유 링크입니다.' });
        }
        const me = new Types.ObjectId(userId);
        if (share.ownerId.equals(me)) return;
        // 이미 담은 사람은 조건에서 빠져 두 번 담기지 않는다 (동시에 눌러도 한 번)
        await this.shareModel.updateOne(
            { _id: share._id, 'subscribers.userId': { $ne: me } },
            { $push: { subscribers: { userId: me, addedAt: now } } },
        );
    }

    /** 내가 받은 캘린더(취소 · 만료 제외, 최신순)와 그 기간 중 일정이 있는 날짜. 받은 사람에게는 다른 구독자를 보여 주지 않는다 */
    async received(userId: string, now = new Date()): Promise<(CalendarShareView & { days: string[] })[]> {
        const docs = await this.shareModel
            .find({
                'subscribers.userId': new Types.ObjectId(userId),
                revokedAt: null,
                $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
            })
            .sort({ createdAt: -1, _id: -1 })
            .lean<ShareLean[]>();

        const owners = await this.userModel
            .find({ _id: { $in: docs.map((d) => d.ownerId) } }, { nickname: 1 })
            .lean<{ _id: Types.ObjectId; nickname: string }[]>();
        const nickname = new Map(owners.map((o) => [o._id.toString(), o.nickname]));

        return Promise.all(
            docs.map(async (d) => ({
                ...toView(d, false),
                ownerNickname: nickname.get(d.ownerId.toString()),
                days: await this.daysWithContent(d),
            })),
        );
    }

    private async findByKey(key: string): Promise<ShareLean | null> {
        const byToken = await this.shareModel.findOne({ token: key }).lean<ShareLean | null>();
        if (byToken || !Types.ObjectId.isValid(key)) return byToken;
        return this.shareModel.findOne({ _id: new Types.ObjectId(key) }).lean<ShareLean | null>();
    }

    /**
     * 공유 기간 안에서 공유 범위에 해당하는 일정이 있는 날짜 (날짜 순, 서울 기준 'YYYY-MM-DD').
     * todos: 월간 캘린더 hasTodo와 같은 기준 — 그 날짜에 할 일이 있으면(완료 포함) 세고, D-day 짝(isDday=true)은 뺀다.
     * study: 그날 공부 시간이 있는 날
     */
    private async daysWithContent(share: ShareLean): Promise<string[]> {
        const days = new Set<string>();
        if (share.scopes.includes('todos')) {
            const dates = await this.todoModel.distinct('dueDate', {
                userId: share.ownerId,
                isDday: false,
                dueDate: { $gte: share.rangeStart, $lte: share.rangeEnd },
            });
            for (const date of dates) days.add(date);
        }
        if (share.scopes.includes('study')) {
            const records = await this.dailyModel
                .find({ userId: share.ownerId, studyDate: { $gte: share.rangeStart, $lte: share.rangeEnd }, totalSec: { $gt: 0 } }, { studyDate: 1 })
                .lean<{ studyDate: string }[]>();
            for (const record of records) days.add(record.studyDate);
        }
        return [...days].sort();
    }
}

function toView(doc: ShareLean, withSubscribers: boolean): CalendarShareView {
    return {
        _id: doc._id.toString(),
        token: doc.token,
        ownerId: doc.ownerId.toString(),
        rangeStart: doc.rangeStart,
        rangeEnd: doc.rangeEnd,
        scopes: doc.scopes,
        expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
        revokedAt: doc.revokedAt ? doc.revokedAt.toISOString() : null,
        createdAt: doc.createdAt.toISOString(),
        subscribers: withSubscribers ? doc.subscribers.map((s) => ({ userId: s.userId.toString(), addedAt: s.addedAt.toISOString() })) : [],
    };
}
