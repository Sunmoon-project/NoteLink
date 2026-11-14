import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type ClientSession, type Connection, isValidObjectId, Model, Types } from 'mongoose';

import { SESSION_DAILY_REWARD_LIMIT, sessionReward } from '../reward/point/point-rules.js';
import { PointService } from '../reward/point/point.service.js';
import type { CreateStudyItemDto } from './dto/create-study-item.dto.js';
import type { EndStudySessionDto } from './dto/end-study-session.dto.js';
import type { StartStudySessionDto } from './dto/start-study-session.dto.js';
import { DailyRecord, type StudyItem } from '../progress/schemas/daily-record.schema.js';
import { StudySession, type SessionMode, type SessionStatus } from './schemas/study-session.schema.js';
import { Subject } from './schemas/subject.schema.js';
import { ABUSE_SEC, DAILY_CAP_SEC, netDurationSec, secondsBySeoulDay, seoulDate, STREAK_MIN_SEC } from './study-time.js';

/** 앱에 내려주는 공부 항목 (공유 계약 StudyItem과 같은 모양) */
export interface StudyItemView {
    _id: string;
    title: string;
    subjectId: string | null;
    subjectName?: string;
    goalMin: number | null;
    accumulatedSec: number;
}

/** 앱에 내려주는 하루 기록 (공유 계약 DailyRecord) */
export interface DailyRecordView {
    _id: string;
    studyDate: string;
    totalSec: number;
    personalSec: number;
    roomSec: number;
    streakOk: boolean;
    items: StudyItemView[];
}

/** 앱에 내려주는 과목 (공유 계약 Subject) */
export interface SubjectView {
    _id: string;
    categoryId: string | null;
    name: string;
    color: string;
    sortOrder: number;
    isActive: boolean;
}

/** 앱에 내려주는 세션 (공유 계약 StudySession) */
export interface StudySessionView {
    _id: string;
    studyDate: string;
    studyItemId: string | null;
    roomId: string | null;
    mode: SessionMode;
    status: SessionStatus;
    startedAt: string;
    endedAt: string | null;
    durationSec: number;
    departureCount: number;
    endReason: string | null;
    isAbuse: boolean;
    pauses: { startedAt: string; endedAt: string | null; reason: string | null }[];
}

export interface EndResult {
    durationSec: number;
    pointsEarned: number;
}

// DB에서 꺼낸 문서 (lean: Mongoose 기능 없이 순수 객체)
type StudyItemLean = StudyItem & { _id: Types.ObjectId };
type DailyRecordLean = Omit<DailyRecord, 'items'> & { _id: Types.ObjectId; items: StudyItemLean[] };
type SubjectLean = Subject & { _id: Types.ObjectId };
type StudySessionLean = StudySession & { _id: Types.ObjectId };

@Injectable()
export class StudyService {
    constructor(
        @InjectModel(StudySession.name) private readonly sessionModel: Model<StudySession>,
        @InjectModel(DailyRecord.name) private readonly dailyModel: Model<DailyRecord>,
        @InjectModel(Subject.name) private readonly subjectModel: Model<Subject>,
        @InjectConnection() private readonly connection: Connection,
        private readonly points: PointService,
    ) { }

    /** 오늘(서울 기준)의 하루 기록. 아직 없으면 빈 기록을 만들어 돌려준다 */
    async today(userId: string): Promise<DailyRecordView> {
        const record = await this.ensureDailyRecord(new Types.ObjectId(userId), seoulDate(new Date()));
        return toDailyView(record);
    }

    /** 과목 목록 (쓰는 것만, 정렬 순서대로) */
    async listSubjects(): Promise<SubjectView[]> {
        const docs = await this.subjectModel
            .find({ isActive: true })
            .sort({ sortOrder: 1 })
            .lean<SubjectLean[]>();
        return docs.map(toSubjectView);
    }

    /** 오늘 기록에 공부 항목 하나를 더한다 */
    async addItem(userId: string, dto: CreateStudyItemDto): Promise<StudyItemView> {
        const owner = new Types.ObjectId(userId);
        const studyDate = seoulDate(new Date());
        await this.ensureDailyRecord(owner, studyDate);

        const subject = dto.subjectName
            ? await this.subjectModel.findOne({ name: dto.subjectName, isActive: true }).lean<SubjectLean>()
            : null;
        const item: StudyItemLean = {
            _id: new Types.ObjectId(),
            title: dto.title,
            subjectId: subject?._id ?? null,
            subjectName: dto.subjectName || null,
            goalMin: dto.goalMin ?? null,
            accumulatedSec: 0,
        };
        await this.dailyModel.updateOne({ userId: owner, studyDate }, { $push: { items: item } });
        return toItemView(item);
    }

    /**
     * 세션 시작. 오늘 기록에 없는 공부 항목이면 undefined.
     * 이 사람이 이미 열어 둔 세션(달리는 중 · 멈춘 중)이 있으면 먼저 정산하며 닫는다.
     * 한 사람이 동시에 여러 세션을 돌려 시간 · 포인트를 부풀리지 못하게 하고, 앱이 꺼져서 남은 세션도 정리한다
     */
    async startSession(userId: string, dto: StartStudySessionDto): Promise<StudySessionView | undefined> {
        const owner = new Types.ObjectId(userId);
        const studyDate = seoulDate(new Date());
        const studyItemId = new Types.ObjectId(dto.studyItemId);

        const record = await this.dailyModel
            .findOne({ userId: owner, studyDate, 'items._id': studyItemId }, { _id: 1 })
            .lean<{ _id: Types.ObjectId }>();
        if (!record) return undefined;

        // 열린 세션 정산 + 새 세션 만들기를 한 묶음으로. 트랜잭션 안이라 await를 순서대로 쓴다
        const run = (): Promise<StudySessionView> => this.connection.transaction(async (tx) => {
            const open = await this.sessionModel
                .find({ userId: owner, status: { $ne: 'ended' } }, null, { session: tx })
                .lean<StudySessionLean[]>();
            for (const row of open) {
                await this.settle(userId, owner, row, 'replaced', tx);
            }

            const session: StudySessionLean = {
                _id: new Types.ObjectId(),
                userId: owner,
                studyDate,
                studyItemId,
                roomId: null,
                mode: dto.mode,
                status: 'running',
                startedAt: new Date(),
                endedAt: null,
                durationSec: 0,
                departureCount: 0,
                endReason: null,
                isAbuse: false,
                pointsEarned: 0,
                pauses: [],
            };
            await this.sessionModel.create([session], { session: tx });
            return toSessionView(session);
        });

        try {
            return await run();
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
            // 동시에 시작한 다른 요청이 먼저 세션을 만들어 DB의 "열린 세션은 하나" 규칙에 걸린 경우:
            // 전체를 한 번만 다시 실행한다. 이번에는 먼저 생긴 세션이 열린 세션으로 보여 'replaced'로 정산된다.
            // 두 번째도 실패하면 오류를 그대로 던진다
            return run();
        }
    }

    /**
     * 일시정지. 내 세션이 아니거나 없으면 false.
     * 이미 멈췄거나 끝난 세션이면 아무것도 바꾸지 않고 true (앱이 연달아 눌러도 같은 결과)
     */
    async pause(userId: string, sessionId: string): Promise<boolean> {
        const row = await this.findOwnedSession(userId, sessionId);
        if (!row) return false;
        if (row.status !== 'running') return true;

        // 읽은 뒤에도 running일 때만 바꾼다 → 거의 동시에 두 번 눌러도 정지는 한 번만 기록됨
        await this.sessionModel.updateOne(
            { _id: row._id, status: 'running' },
            {
                $set: { status: 'paused' },
                $push: { pauses: { startedAt: new Date(), endedAt: null, reason: 'manual' } },
            },
        );
        return true;
    }

    /** 재개. pause와 같은 규칙으로 멈춰 있지 않은 세션은 그대로 true */
    async resume(userId: string, sessionId: string): Promise<boolean> {
        const row = await this.findOwnedSession(userId, sessionId);
        if (!row) return false;
        if (row.status !== 'paused') return true;

        // 아직 끝나지 않은 정지(endedAt: null)의 끝 시각을 지금으로 채운다
        await this.sessionModel.updateOne(
            { _id: row._id, status: 'paused' },
            { $set: { status: 'running', 'pauses.$[open].endedAt': new Date() } },
            { arrayFilters: [{ 'open.endedAt': null }] },
        );
        return true;
    }

    /**
     * 세션 종료. 내 세션이 아니거나 없으면 undefined.
     * 시간은 서버 기록(시작·일시정지 시각)으로 계산하고, 앱이 보낸 시간은 쓰지 않는다.
     * 세션 마감 · 하루 기록 · 포인트 적립이 한 묶음(트랜잭션)이다.
     * 이미 끝난 세션이면 처음 계산한 결과를 그대로 돌려준다 (중복 적립 없음)
     */
    async end(userId: string, sessionId: string, dto: EndStudySessionDto): Promise<EndResult | undefined> {
        if (!isValidObjectId(sessionId)) return undefined;
        const owner = new Types.ObjectId(userId);
        const id = new Types.ObjectId(sessionId);

        return this.connection.transaction(async (tx) => {
            const row = await this.sessionModel
                .findOne({ _id: id, userId: owner }, null, { session: tx })
                .lean<StudySessionLean>();
            if (!row) return undefined;
            if (row.status === 'ended') return { durationSec: row.durationSec, pointsEarned: row.pointsEarned };

            return this.settle(userId, owner, row, dto.endReason, tx);
        });
    }

    /**
     * 끝나지 않은 세션 하나를 정산한다: 시간 계산 · 세션 마감 · 하루 기록 · 포인트 적립.
     * 트랜잭션 안에서 부른다 (end와 startSession이 함께 쓴다)
     */
    private async settle(
        userId: string,
        owner: Types.ObjectId,
        row: StudySessionLean,
        endReason: string,
        tx: ClientSession,
    ): Promise<EndResult> {
        const endedAt = new Date();
        const days = secondsBySeoulDay(row.startedAt, endedAt, row.pauses);
        // 24시간 넘게 이어진 세션은 방치로 본다 (FR-06-16). 지우지 않고 표시만 하고 통계·포인트에서 뺀다.
        // 날짜별로 나누면 날짜마다 초 아래가 버려져 합계가 모자라므로, 방치 판정은 전체 순공 시간으로 한다
        const isAbuse = netDurationSec(row.startedAt, row.pauses, endedAt) >= ABUSE_SEC;

        // 날짜마다 하루 상한(16시간)까지만 쌓는다 (FR-06-15). 트랜잭션 안이라 await를 순서대로 쓴다
        let durationSec = 0;
        if (!isAbuse) {
            // 과목은 세션 시작 때의 공부 항목에서 정해지므로 정산할 때 한 번만 찾아 모든 날짜에 쓴다
            const subjectId = await this.findSessionSubject(owner, row, tx);
            for (const [studyDate, sec] of days) {
                durationSec += await this.addToDay(owner, studyDate, sec, row, subjectId, tx);
            }
        }
        let reward = isAbuse ? undefined : sessionReward(durationSec);
        // 보상은 끝낸 날(서울) 기준으로 센다. 앱(#203)도 오늘 받은 포인트로 한도를 센다
        const rewardDate = seoulDate(endedAt);
        if (reward) {
            // 세션 보상은 하루 2번까지 (#194). 같은 날 세션 둘이 동시에 끝나도 끝낸 날의 하루 기록을 반드시 한 번 쓰기 때문에
            // (위 addToDay가 상한 때문에 아무것도 안 쓴 경우도 포함) 한쪽이 충돌로 다시 시도되고, 그때 센 횟수가 맞게 나온다
            await this.touchDailyRecord(owner, rewardDate, endedAt, tx);
            const rewarded = await this.points.countEarned(userId, reward.reasonType, rewardDate, tx);
            if (rewarded >= SESSION_DAILY_REWARD_LIMIT) reward = undefined;
        }
        const pointsEarned = reward?.amount ?? 0;

        // 끝나지 않은 세션일 때만 마감 + 열려 있는 정지가 있으면 지금 시각으로 닫는다
        await this.sessionModel.updateOne(
            { _id: row._id, status: { $ne: 'ended' } },
            {
                $set: {
                    status: 'ended',
                    endedAt,
                    durationSec,
                    isAbuse,
                    endReason,
                    pointsEarned,
                    'pauses.$[open].endedAt': endedAt,
                },
            },
            { arrayFilters: [{ 'open.endedAt': null }], session: tx },
        );

        if (reward) {
            await this.points.earn(userId, reward.amount, reward.reasonType, reward.description, tx, {
                sessionId: row._id,
                studyDate: rewardDate,
            });
        }
        return { durationSec, pointsEarned };
    }

    /**
     * 그 날짜 하루 기록을 트랜잭션 안에서 반드시 한 번 쓴다 (없으면 만들고, 있으면 updatedAt만 갱신).
     * 같은 날 동시에 끝나는 세션끼리 쓰기 충돌이 나게 해서 보상 횟수 검사가 어긋나지 않게 한다
     */
    private async touchDailyRecord(owner: Types.ObjectId, studyDate: string, at: Date, tx: ClientSession): Promise<void> {
        await this.dailyModel.updateOne(
            { userId: owner, studyDate },
            {
                $set: { updatedAt: at },
                $setOnInsert: { totalSec: 0, personalSec: 0, roomSec: 0, streakOk: false, items: [] },
            },
            { upsert: true, session: tx },
        );
    }

    /**
     * 세션이 시작한 날의 공부 항목에 달린 과목 id. 항목이 없거나 과목이 없는 항목이면 null.
     * 정산할 때 한 번만 읽는다 (날짜마다 읽지 않는다)
     */
    private async findSessionSubject(owner: Types.ObjectId, row: StudySessionLean, tx: ClientSession): Promise<Types.ObjectId | null> {
        if (!row.studyItemId) return null;
        const record = await this.dailyModel
            .findOne({ userId: owner, studyDate: row.studyDate, 'items._id': row.studyItemId }, { 'items.$': 1 }, { session: tx })
            .lean<{ items?: { subjectId?: Types.ObjectId | null }[] }>();
        return record?.items?.[0]?.subjectId ?? null;
    }

    /**
     * 그 날짜 하루 기록에 sec초를 쌓는다. 하루 상한(16시간)을 넘는 부분은 빼고, 실제로 쌓은 초를 돌려준다.
     * 시작한 날이면 공부 항목에도 쌓고, 합계가 10분을 넘으면 streakOk를 켠다.
     * 과목이 있으면 시작한 날이든 아니든(자정을 넘긴 날도) 그날 쌓은 초만큼 과목별 시간(subjectSec)에 쌓는다
     */
    private async addToDay(
        owner: Types.ObjectId,
        studyDate: string,
        sec: number,
        row: StudySessionLean,
        subjectId: Types.ObjectId | null,
        tx: ClientSession,
    ): Promise<number> {
        const existing = await this.dailyModel
            .findOne({ userId: owner, studyDate }, { totalSec: 1, streakOk: 1 }, { session: tx })
            .lean<{ totalSec: number; streakOk: boolean }>();
        const before = existing?.totalSec ?? 0;
        const counted = Math.max(0, Math.min(sec, DAILY_CAP_SEC - before));
        if (counted === 0) return 0;

        const inc: Record<string, number> = {
            totalSec: counted,
            [row.mode === 'room' ? 'roomSec' : 'personalSec']: counted,
        };
        const options: { session: ClientSession; upsert?: boolean; arrayFilters?: Record<string, unknown>[] } = {
            session: tx,
        };
        if (row.studyItemId && studyDate === row.studyDate) {
            inc['items.$[item].accumulatedSec'] = counted;
            options.arrayFilters = [{ 'item._id': row.studyItemId }];
        }
        if (subjectId) inc[`subjectSec.${subjectId.toString()}`] = counted;

        const reachesStreak = before + counted >= STREAK_MIN_SEC;
        const update: Record<string, Record<string, unknown>> = { $inc: inc };
        if (reachesStreak && !existing?.streakOk) update.$set = { streakOk: true };
        if (!existing) {
            // 시작한 날이 아닌 날(자정을 넘긴 부분)은 기록이 아직 없을 수 있어 새로 만든다
            options.upsert = true;
            update.$setOnInsert = { items: [], ...(update.$set ? {} : { streakOk: false }) };
        }
        await this.dailyModel.updateOne({ userId: owner, studyDate }, update, options);
        return counted;
    }

    private async findOwnedSession(userId: string, sessionId: string): Promise<StudySessionLean | null> {
        // ObjectId 모양이 아닌 ID는 DB에 묻지 않고 바로 "없음" (그냥 물으면 500 에러)
        if (!isValidObjectId(sessionId)) return null;
        return this.sessionModel
            .findOne({ _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId) })
            .lean<StudySessionLean>();
    }

    /** 이 사람의 이 날짜 기록을 찾고, 없으면 만든다 */
    private async ensureDailyRecord(userId: Types.ObjectId, studyDate: string): Promise<DailyRecordLean> {
        const filter = { userId, studyDate };
        try {
            const doc = await this.dailyModel
                .findOneAndUpdate(
                    filter,
                    { $setOnInsert: { totalSec: 0, personalSec: 0, roomSec: 0, streakOk: false, items: [] } },
                    { upsert: true, returnDocument: 'after' },
                )
                .lean<DailyRecordLean>();
            if (doc) return doc;
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }
        // 동시에 두 요청이 기록을 만들려 해서 한쪽이 막힌 경우: 먼저 만들어진 기록을 읽는다
        const existing = await this.dailyModel.findOne(filter).lean<DailyRecordLean>();
        if (!existing) throw new Error('daily_records 기록을 만들지 못했습니다.');
        return existing;
    }
}

/** MongoDB 중복 키 오류(unique 인덱스 위반)인지 */
function isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/** DB 문서 → 앱 응답 모양 (ID는 글자로, 날짜는 ISO 문자열로) */
function toItemView(item: StudyItemLean): StudyItemView {
    return {
        _id: item._id.toString(),
        title: item.title,
        subjectId: item.subjectId ? item.subjectId.toString() : null,
        ...(item.subjectName ? { subjectName: item.subjectName } : {}),
        goalMin: item.goalMin,
        accumulatedSec: item.accumulatedSec,
    };
}

function toDailyView(doc: DailyRecordLean): DailyRecordView {
    return {
        _id: doc._id.toString(),
        studyDate: doc.studyDate,
        totalSec: doc.totalSec,
        personalSec: doc.personalSec,
        roomSec: doc.roomSec,
        streakOk: doc.streakOk,
        items: doc.items.map(toItemView),
    };
}

function toSubjectView(doc: SubjectLean): SubjectView {
    return {
        _id: doc._id.toString(),
        categoryId: doc.categoryId ? doc.categoryId.toString() : null,
        name: doc.name,
        color: doc.color,
        sortOrder: doc.sortOrder,
        isActive: doc.isActive,
    };
}

function toSessionView(doc: StudySessionLean): StudySessionView {
    return {
        _id: doc._id.toString(),
        studyDate: doc.studyDate,
        studyItemId: doc.studyItemId ? doc.studyItemId.toString() : null,
        roomId: doc.roomId ? doc.roomId.toString() : null,
        mode: doc.mode,
        status: doc.status,
        startedAt: doc.startedAt.toISOString(),
        endedAt: doc.endedAt ? doc.endedAt.toISOString() : null,
        durationSec: doc.durationSec,
        departureCount: doc.departureCount,
        endReason: doc.endReason,
        isAbuse: doc.isAbuse,
        pauses: doc.pauses.map((pause) => ({
            startedAt: pause.startedAt.toISOString(),
            endedAt: pause.endedAt ? pause.endedAt.toISOString() : null,
            reason: pause.reason,
        })),
    };
}
