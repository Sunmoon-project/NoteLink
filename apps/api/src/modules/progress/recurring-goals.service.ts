import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { HolidaysService } from '../calendar/holidays.service.js';
import { Subject } from '../session/schemas/subject.schema.js';
import { seoulDate } from '../session/study-time.js';
import type { SaveRecurringGoalDto } from './dto/recurring-goal.dto.js';
import { weeklyStreak, type DayStudy, type GoalRule } from './goal-judge.js';
import { DailyRecord } from './schemas/daily-record.schema.js';
import { RecurringGoal } from './schemas/recurring-goal.schema.js';
import { addDays, weekStartOf } from './week.js';

/** 앱에 내려주는 반복 목표 (shared RecurringGoal) */
export interface RecurringGoalView {
    _id: string;
    name: string;
    days: number[];
    targetMin: number;
    subjectId: string | null;
    remindEnabled: boolean;
    remindTime: string | null;
    pausedUntil: string | null;
    streak: number;
    isActive: boolean;
}

type GoalLean = RecurringGoal & { _id: Types.ObjectId; createdAt?: Date };
type DayLean = { studyDate: string; totalSec: number; items?: { subjectId?: Types.ObjectId | null; accumulatedSec: number }[] };

/** 연속 달성 주 수를 셀 때 읽는 공부 기록의 최대 기간(일). 약 2년 */
export const MAX_LOOKBACK_DAYS = 730;

const VALIDATION_FAILED = 'VALIDATION_FAILED';
const NOT_FOUND = { code: 'NOT_FOUND', message: '존재하지 않는 반복 목표입니다.' };
const DEFAULT_TARGET_MIN = 30; // 앱(local/api.ts)이 새 목표에 넣는 값

@Injectable()
export class RecurringGoalsService {
    constructor(
        @InjectModel(RecurringGoal.name) private readonly goalModel: Model<RecurringGoal>,
        @InjectModel(Subject.name) private readonly subjectModel: Model<Subject>, // 과목이 있는지 확인한다 (읽기만)
        @InjectModel(DailyRecord.name) private readonly dailyModel: Model<DailyRecord>, // 연속 달성 판정에 하루 기록을 읽기만 한다
        private readonly holidays: HolidaysService, // 건너뛸 날(공휴일 · 내 제외일)
    ) { }

    /** 내 반복 목표 (지운 것 제외), 만든 순서. streak은 조회할 때 계산한다(저장하지 않는다) */
    async list(userId: string, now: Date = new Date()): Promise<RecurringGoalView[]> {
        const docs = await this.goalModel
            .find({ userId: new Types.ObjectId(userId), deletedAt: null })
            .sort({ createdAt: 1, _id: 1 })
            .lean<GoalLean[]>();
        const streaks = await this.streaks(userId, docs, now);
        return docs.map((goal) => toView(goal, streaks.get(goal._id.toString()) ?? 0));
    }

    /** 만든다. 이름과 요일은 꼭 있어야 하고, 나머지는 앱과 같은 기본값 */
    async create(userId: string, dto: SaveRecurringGoalDto): Promise<RecurringGoalView> {
        if (dto.name === undefined || dto.days === undefined) {
            throw new BadRequestException({ code: VALIDATION_FAILED, message: '목표 이름과 요일이 필요합니다.' });
        }
        await this.requireActiveSubject(dto.subjectId);
        const created = await this.goalModel.create({
            targetMin: DEFAULT_TARGET_MIN,
            remindEnabled: false,
            isActive: true,
            ...toFields(dto),
            userId: new Types.ObjectId(userId),
            name: dto.name,
            days: sortedDays(dto.days),
        });
        return toView(created.toObject() as unknown as GoalLean, 0); // 방금 만든 목표는 지난 주가 없다
    }

    /** 보낸 필드만 바꾼다. 남의 목표 · 지운 목표 · 없는 목표는 404 */
    async update(userId: string, id: string, dto: SaveRecurringGoalDto): Promise<RecurringGoalView> {
        await this.requireActiveSubject(dto.subjectId);
        const fields = toFields(dto);
        if (dto.name !== undefined) fields['name'] = dto.name;
        if (dto.days !== undefined) fields['days'] = sortedDays(dto.days);
        const saved = await this.goalModel
            .findOneAndUpdate(ownedAlive(userId, id), { $set: fields }, { returnDocument: 'after' })
            .lean<GoalLean>();
        if (!saved) throw new NotFoundException(NOT_FOUND);
        const streaks = await this.streaks(userId, [saved], new Date());
        return toView(saved, streaks.get(saved._id.toString()) ?? 0);
    }

    /**
     * 과목은 모든 사용자가 같이 쓰는 목록이라 소유자 검사는 없다.
     * null이거나 안 보냈으면 통과, 아니면 subjects에 있고 isActive인 과목이어야 한다 (공부 타이머와 같은 기준)
     */
    private async requireActiveSubject(subjectId: string | null | undefined): Promise<void> {
        if (subjectId === undefined || subjectId === null) return;
        const found = await this.subjectModel.findOne({ _id: new Types.ObjectId(subjectId), isActive: true }).lean();
        if (!found) throw new BadRequestException({ code: VALIDATION_FAILED, message: '존재하지 않는 과목입니다.' });
    }

    /**
     * 목표마다 연속 달성 주 수를 구한다. 공부 기록과 건너뛸 날은 목록 전체에 필요한 기간을 한 번씩만 읽고(목표마다 읽지 않는다),
     * 판정은 순수 함수(goal-judge.ts)가 한다. 쉬는 목표(isActive=false)는 읽을 것 없이 0이다.
     * 목표를 고치면 과거 판정도 지금 설정으로 다시 계산된다
     */
    private async streaks(userId: string, goals: GoalLean[], now: Date): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        const running = goals.filter((g) => g.isActive);
        if (running.length === 0) return result;

        const today = seoulDate(now);
        const rules = running.map((g) => ({ id: g._id.toString(), rule: toRule(g) }));
        const earliest = rules.map((r) => r.rule.createdDate).reduce((a, b) => (a < b ? a : b));
        const limit = addDays(today, -MAX_LOOKBACK_DAYS);
        const from = earliest > limit ? earliest : limit;
        const weekEnd = addDays(weekStartOf(today), 6); // 이번 주 남은 날의 공휴일도 알아야 "남은 날"을 바르게 센다

        const [records, skipList] = await Promise.all([
            this.dailyModel
                .find(
                    { userId: new Types.ObjectId(userId), studyDate: { $gte: from, $lte: today } },
                    { studyDate: 1, totalSec: 1, 'items.subjectId': 1, 'items.accumulatedSec': 1 },
                )
                .lean<DayLean[]>(),
            this.holidays.skipDates(userId, from, weekEnd),
        ]);
        const study = new Map(records.map((r) => [r.studyDate, toDayStudy(r)]));
        const skipDates = new Set(skipList);
        for (const { id, rule } of rules) result.set(id, weeklyStreak(rule, today, study, skipDates, from));
        return result;
    }

    /** 지우지 않고 지운 시각만 표시한다 (FR-11-10). 과거 이력은 남는다 */
    async remove(userId: string, id: string): Promise<void> {
        const done = await this.goalModel.updateOne(ownedAlive(userId, id), { $set: { deletedAt: new Date() } });
        if (done.matchedCount === 0) throw new NotFoundException(NOT_FOUND);
    }
}

/** 내 것이면서 아직 안 지운 목표만 찾는 조건. id 모양이 틀리면 아무것도 못 찾게 한다 */
function ownedAlive(userId: string, id: string) {
    const _id = /^[0-9a-f]{24}$/i.test(id) ? new Types.ObjectId(id) : new Types.ObjectId('000000000000000000000000');
    return { _id, userId: new Types.ObjectId(userId), deletedAt: null };
}

/**
 * 쉬는 날짜를 순간(Date)으로 바꾼다. 서버 시간대와 상관없이 같은 값이 나온다.
 * 'YYYY-MM-DD'는 서울 자정, 시간대가 붙은 일시(Z · +09:00)는 그 순간 그대로 (DTO가 이 두 모양만 통과시킨다)
 */
export function parsePausedUntil(value: string): Date {
    return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+09:00` : value);
}

const sortedDays = (days: number[]) => [...days].sort((a, b) => a - b);

/** 보낸 값 중 바꿀 수 있는 것만 저장 모양으로 (서버가 정하는 _id · streak은 버린다. 이름 · 요일은 호출한 쪽이 넣는다) */
function toFields(dto: SaveRecurringGoalDto): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (dto.targetMin !== undefined) fields['targetMin'] = dto.targetMin;
    if (dto.subjectId !== undefined) fields['subjectId'] = dto.subjectId === null ? null : new Types.ObjectId(dto.subjectId);
    if (dto.remindEnabled !== undefined) fields['remindEnabled'] = dto.remindEnabled;
    if (dto.remindTime !== undefined) fields['remindTime'] = dto.remindTime;
    if (dto.pausedUntil !== undefined) fields['pausedUntil'] = dto.pausedUntil === null ? null : parsePausedUntil(dto.pausedUntil);
    if (dto.isActive !== undefined) fields['isActive'] = dto.isActive;
    return fields;
}

/** 하루 기록에서 총 시간과 과목별 시간을 뽑는다. 같은 과목 항목이 여러 개면 더한다 */
function toDayStudy(record: DayLean): DayStudy {
    const bySubject = new Map<string, number>();
    for (const item of record.items ?? []) {
        if (!item.subjectId) continue;
        const key = item.subjectId.toString();
        bySubject.set(key, (bySubject.get(key) ?? 0) + item.accumulatedSec);
    }
    return { totalSec: record.totalSec, bySubject };
}

/** 저장된 목표를 판정 규칙으로. 날짜는 서울 날짜로 바꾼다(만든 시각 · pausedUntil 모두 순간으로 저장돼 있다) */
function toRule(goal: GoalLean): GoalRule {
    return {
        isActive: goal.isActive,
        days: goal.days,
        targetSec: goal.targetMin * 60,
        subjectId: goal.subjectId ? goal.subjectId.toString() : null,
        createdDate: seoulDate(goal.createdAt ?? new Date(0)),
        pausedUntil: goal.pausedUntil ? seoulDate(goal.pausedUntil) : null,
    };
}

function toView(goal: GoalLean, streak: number): RecurringGoalView {
    return {
        _id: goal._id.toString(),
        name: goal.name,
        days: goal.days,
        targetMin: goal.targetMin,
        subjectId: goal.subjectId ? goal.subjectId.toString() : null,
        remindEnabled: goal.remindEnabled,
        remindTime: goal.remindTime ?? null,
        pausedUntil: goal.pausedUntil ? goal.pausedUntil.toISOString() : null,
        streak,
        isActive: goal.isActive,
    };
}
