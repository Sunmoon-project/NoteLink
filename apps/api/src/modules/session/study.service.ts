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

/** 앱이 꺼진 세션을 새 타이머가 닫을 때, 마지막 신호 뒤로 더 인정하는 시간 */
export const LAST_SEEN_GRACE_MS = 2 * 60 * 1000;

type PauseLean = StudySessionLean['pauses'][number];

/**
 * 앱이 마지막으로 살아 있던 시각: lastSeenAt · 시작 시각 · 모든 정지의 시작 · 끝 중 가장 늦은 것.
 * 일시정지 · 재개도 앱이 보낸 요청이라 살아 있던 증거다(lastSeenAt이 없는 옛 세션도 정지 기록으로 알 수 있다)
 */
export function lastAliveAt(row: Pick<StudySessionLean, 'startedAt' | 'lastSeenAt' | 'pauses'>): Date {
    let latest = Math.max(row.startedAt.getTime(), row.lastSeenAt?.getTime() ?? 0);
    for (const pause of row.pauses) {
        latest = Math.max(latest, pause.startedAt.getTime(), pause.endedAt?.getTime() ?? 0);
    }
    return new Date(latest);
}

/**
 * 끝 시각(endedAt)까지로 맞춘 정지 목록. 끝 시각 이후에 시작한 정지는 빼고, 끝 시각에 걸친 정지는 끝 시각으로 자른다
 * (안 그러면 정지 시간이 음수가 되어 순공이 늘어난다). 열린 정지는 그대로 둔다(계산은 끝 시각까지로 본다).
 * changed: 빼거나 자른 정지가 있는지
 */
function pausesUntil(pauses: PauseLean[], endedAt: Date): { list: PauseLean[]; changed: boolean } {
    const end = endedAt.getTime();
    const list: PauseLean[] = [];
    let changed = false;
    for (const pause of pauses) {
        if (pause.startedAt.getTime() >= end) {
            changed = true;
        } else if (pause.endedAt && pause.endedAt.getTime() > end) {
            list.push({ ...pause, endedAt });
            changed = true;
        } else {
            list.push(pause);
        }
    }
    return { list, changed };
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
     * 공부 항목 지우기(HOME-002): 기록은 남기고 오늘 항목에 deletedAt만 채워 오늘 목록에서 숨긴다(지난 날 항목은 404).
     * 쌓인 시간(accumulatedSec) · 하루 합계 · 과목 시간(subjectSec)은 건드리지 않아 통계 · 학습 기록 · 목표 판정에 계속 들어간다.
     * - 'deleted': 지웠다 · 이미 지운 항목이다(멱등 — 처음 지운 시각을 그대로 둔다)
     * - 'not_found': 내 항목이 아니거나 없다(남의 항목인지 알려 주지 않는다)
     * - 'in_session': 이 항목으로 측정 중 · 일시정지 중인 세션이 있다. 공부를 끝낸 뒤 지운다
     */
    async removeItem(userId: string, itemId: string): Promise<'deleted' | 'not_found' | 'in_session'> {
        if (!isValidObjectId(itemId)) return 'not_found';
        const owner = new Types.ObjectId(userId);
        const id = new Types.ObjectId(itemId);

        const studyDate = seoulDate(new Date());

        // 지우기와 열린 세션 확인을 한 트랜잭션으로. 세션 시작(startSession)도 트랜잭션 안에서 같은 하루 기록을 먼저 쓰므로
        // 둘이 겹치면 쓰기 충돌로 한쪽이 다시 실행된다 → 시작이 먼저면 여기서 열린 세션이 보여 409, 지우기가 먼저면 시작이 404.
        // 지운 항목 위에서 타이머가 도는 일이 없다
        try {
            return await this.connection.transaction(async (tx) => {
                const record = await this.dailyModel
                    .findOne({ userId: owner, studyDate, 'items._id': id }, { 'items.$': 1 }, { session: tx })
                    .lean<{ items?: { deletedAt?: Date | null }[] }>();
                const item = record?.items?.[0];
                if (!item) return 'not_found' as const;
                if (item.deletedAt) return 'deleted' as const;

                // 아직 안 지운 항목일 때만 채운다 → 동시에 두 번 지워도 처음 시각이 남는다
                await this.dailyModel.updateOne(
                    { userId: owner, studyDate, items: { $elemMatch: { _id: id, deletedAt: null } } },
                    { $set: { 'items.$.deletedAt': new Date() } },
                    { session: tx },
                );
                const open = await this.sessionModel.countDocuments(
                    { userId: owner, studyItemId: id, status: { $ne: 'ended' } },
                    { session: tx },
                );
                // 측정 중이면 트랜잭션을 되돌려 deletedAt을 쓰지 않는다
                if (open > 0) throw new ItemInSessionError();
                return 'deleted' as const;
            });
        } catch (error) {
            if (error instanceof ItemInSessionError) return 'in_session';
            throw error;
        }
    }

    /**
     * 세션 시작. 오늘 기록에 없거나 지운 공부 항목이면 undefined.
     * 이 사람이 이미 열어 둔 세션(달리는 중 · 멈춘 중)이 있으면 먼저 정산하며 닫는다.
     * 한 사람이 동시에 여러 세션을 돌려 시간 · 포인트를 부풀리지 못하게 하고, 앱이 꺼져서 남은 세션도 정리한다
     */
    async startSession(userId: string, dto: StartStudySessionDto): Promise<StudySessionView | undefined> {
        const owner = new Types.ObjectId(userId);
        const studyDate = seoulDate(new Date());
        const studyItemId = new Types.ObjectId(dto.studyItemId);

        // 열린 세션 정산 + 새 세션 만들기를 한 묶음으로. 트랜잭션 안이라 await를 순서대로 쓴다
        const run = (): Promise<StudySessionView | undefined> => this.connection.transaction(async (tx) => {
            // 오늘 기록에 지우지 않은 그 항목이 있을 때만 시작한다(deletedAt: null은 칸이 없는 옛 항목도 맞는다).
            // 읽기 대신 그 기록을 써서(updatedAt) 동시에 온 항목 지우기(removeItem)와 쓰기 충돌이 나게 한다 — 지운 항목 위에서 타이머가 돌지 않게
            const touched = await this.dailyModel.updateOne(
                { userId: owner, studyDate, items: { $elemMatch: { _id: studyItemId, deletedAt: null } } },
                { $set: { updatedAt: new Date() } },
                { session: tx },
            );
            if (touched.matchedCount === 0) return undefined;

            const open = await this.sessionModel
                .find({ userId: owner, status: { $ne: 'ended' } }, null, { session: tx })
                .lean<StudySessionLean[]>();
            const now = new Date();
            for (const row of open) {
                // 앱이 꺼져 열린 채 남은 세션: 마지막으로 앱이 살아 있던 시각(lastSeenAt · 시작 · 정지 기록 중 가장 늦은 것) + 2분까지만 인정한다
                const endedAt = new Date(Math.min(now.getTime(), lastAliveAt(row).getTime() + LAST_SEEN_GRACE_MS));
                await this.settle(userId, owner, row, 'replaced', tx, endedAt);
            }

            const session: StudySessionLean = {
                _id: new Types.ObjectId(),
                userId: owner,
                studyDate,
                studyItemId,
                roomId: null,
                mode: dto.mode,
                status: 'running',
                startedAt: now,
                lastSeenAt: now,
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
        const now = new Date();
        await this.sessionModel.updateOne(
            { _id: row._id, status: 'running' },
            {
                $set: { status: 'paused' },
                $push: { pauses: { startedAt: now, endedAt: null, reason: 'manual' } },
                $max: { lastSeenAt: now },
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
        const now = new Date();
        await this.sessionModel.updateOne(
            { _id: row._id, status: 'paused' },
            { $set: { status: 'running', 'pauses.$[open].endedAt': now }, $max: { lastSeenAt: now } },
            { arrayFilters: [{ 'open.endedAt': null }] },
        );
        return true;
    }

    /**
     * 앱이 열려 있다는 신호(측정 중 · 일시정지 모두). 내 세션이고 끝나지 않았을 때만 lastSeenAt을 지금(서버 시계)으로 올린다.
     * $max라 늦게 도착한 신호가 값을 뒤로 돌리지 않는다. 남의 세션 · 끝난 세션 · 없는 세션이면 false.
     * 조건에 맞는지만 보므로 값이 그대로여도 맞은 것(matchedCount)으로 센다
     */
    async heartbeat(userId: string, sessionId: string): Promise<boolean> {
        if (!isValidObjectId(sessionId)) return false;
        const result = await this.sessionModel.updateOne(
            { _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId), status: { $ne: 'ended' } },
            { $max: { lastSeenAt: new Date() } },
        );
        return result.matchedCount > 0;
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
     * 트랜잭션 안에서 부른다 (end와 startSession이 함께 쓴다).
     * endedAtOverride: 끝난 시각을 지금 대신 이 시각으로 본다(앱이 꺼진 세션을 마지막 신호까지만 정산할 때). 시간 나누기 ·
     * 상한 · 방치 판정 · 포인트 · 저장하는 endedAt · 열린 정지의 끝이 모두 이 시각을 따른다
     */
    private async settle(
        userId: string,
        owner: Types.ObjectId,
        row: StudySessionLean,
        endReason: string,
        tx: ClientSession,
        endedAtOverride?: Date,
    ): Promise<EndResult> {
        const endedAt = endedAtOverride ?? new Date();
        // 계산에 쓰는 정지와 저장하는 정지를 같게 한다(끝 시각 뒤의 정지는 빼고, 걸친 정지는 끝 시각에서 자름)
        const { list: pauses, changed: pausesChanged } = pausesUntil(row.pauses, endedAt);
        const days = secondsBySeoulDay(row.startedAt, endedAt, pauses);
        // 24시간 넘게 이어진 세션은 방치로 본다 (FR-06-16). 지우지 않고 표시만 하고 통계·포인트에서 뺀다.
        // 날짜별로 나누면 날짜마다 초 아래가 버려져 합계가 모자라므로, 방치 판정은 전체 순공 시간으로 한다
        const isAbuse = netDurationSec(row.startedAt, pauses, endedAt) >= ABUSE_SEC;

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

        // 끝나지 않은 세션일 때만 마감 + 열려 있는 정지가 있으면 끝 시각으로 닫는다.
        // 빼거나 자른 정지가 있으면 계산에 쓴 정지 목록을 그대로 저장한다(트랜잭션 안이라 읽은 뒤 다른 요청이 정지를
        // 바꿨으면 쓰기 충돌로 다시 실행된다). 없으면 열린 정지만 닫는 기존 방식이다
        const closed = {
            status: 'ended',
            endedAt,
            durationSec,
            isAbuse,
            endReason,
            pointsEarned,
        };
        await this.sessionModel.updateOne(
            { _id: row._id, status: { $ne: 'ended' } },
            pausesChanged
                ? { $set: { ...closed, pauses: pauses.map((pause) => (pause.endedAt ? pause : { ...pause, endedAt })) } }
                : { $set: { ...closed, 'pauses.$[open].endedAt': endedAt } },
            pausesChanged ? { session: tx } : { arrayFilters: [{ 'open.endedAt': null }], session: tx },
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
            .findOne({ userId: owner, studyDate }, { totalSec: 1, streakOk: 1, subjectSec: 1, items: 1 }, { session: tx })
            .lean<{
                totalSec: number;
                streakOk: boolean;
                subjectSec?: Record<string, number> | null;
                items?: { subjectId?: Types.ObjectId | null; accumulatedSec: number }[];
            }>();
        const before = existing?.totalSec ?? 0;
        const counted = Math.max(0, Math.min(sec, DAILY_CAP_SEC - before));
        if (counted === 0) return 0;

        // 과목별 시간 칸이 생기기 전의 옛 기록: 이번 정산분을 더하기 전에 이전 공부 시간(items 기준)을 먼저 옮겨 담는다.
        // 안 그러면 칸이 이번 분만으로 새로 생겨 판정이 items를 무시하고 이전 시간을 잃는다.
        // subjectSec이 없을 때만 바꾸는 조건이라 두 번 옮겨지지 않고, 같은 날 동시 정산은 트랜잭션 쓰기 충돌로 다시 시도된다
        if (existing && !existing.subjectSec && subjectId) {
            const carried: Record<string, number> = {};
            for (const item of existing.items ?? []) {
                if (!item.subjectId) continue;
                const key = item.subjectId.toString();
                carried[key] = (carried[key] ?? 0) + item.accumulatedSec;
            }
            if (Object.keys(carried).length > 0) {
                await this.dailyModel.updateOne(
                    { userId: owner, studyDate, subjectSec: { $exists: false } },
                    { $set: { subjectSec: carried } },
                    { session: tx },
                );
            }
        }

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

/** 지우려는 항목으로 열린 세션이 있어 지우기 트랜잭션을 되돌릴 때 쓰는 표시 */
class ItemInSessionError extends Error {}

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
        // 지운 항목은 목록에서만 뺀다. 합계(totalSec 등)에는 그 항목의 시간도 그대로 들어 있다
        items: doc.items.filter((item) => !item.deletedAt).map(toItemView),
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
