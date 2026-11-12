import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { seoulDate } from '../session/study-time.js';
import type { SetWeeklyGoalDto } from './dto/set-weekly-goal.dto.js';
import { DailyRecord } from './schemas/daily-record.schema.js';
import { WeeklyGoal } from './schemas/weekly-goal.schema.js';
import { addDays, sumRange, weekStartOf } from './week.js';

/** 앱에 내려주는 이번 주 목표 (공유 계약 WeeklyGoal) */
export interface WeeklyGoalView {
    _id: string;
    weekStart: string;
    targetMin: number;
    notify80: boolean;
    recentAvgMin: number;
}

type GoalLean = WeeklyGoal & { _id: Types.ObjectId };
type DayTotalLean = Pick<DailyRecord, 'studyDate' | 'totalSec'>;

// 목표를 아직 안 정한 사람의 기본값 (앱 mock · shared와 같다)
const DEFAULT_TARGET_MIN = 0;
const DEFAULT_NOTIFY80 = true;
// 앱 mock처럼 목표 분은 0 ~ 7일(10,080분)로 맞춘다
const MAX_TARGET_MIN = 7 * 24 * 60;

@Injectable()
export class ProgressService {
    constructor(
        @InjectModel(DailyRecord.name) private readonly dailyModel: Model<DailyRecord>,
        @InjectModel(WeeklyGoal.name) private readonly goalModel: Model<WeeklyGoal>,
    ) { }

    /** 이번 주 목표 (+ 목표를 정할 때 참고할 최근 4주 평균) */
    async getWeeklyGoal(userId: string, now = new Date()): Promise<WeeklyGoalView> {
        const owner = new Types.ObjectId(userId);
        const weekStart = weekStartOf(seoulDate(now));
        const [goal, recentAvgMin] = await Promise.all([
            this.findGoal(owner, weekStart),
            this.recentAvgMin(owner, weekStart),
        ]);
        return toGoalView(weekStart, goal, recentAvgMin);
    }

    /** 이번 주 목표를 정한다. 이미 있으면 바꾼다 (같은 주에 동시에 두 번 와도 한 건만 남는다) */
    async setWeeklyGoal(userId: string, dto: SetWeeklyGoalDto, now = new Date()): Promise<WeeklyGoalView> {
        const owner = new Types.ObjectId(userId);
        const weekStart = weekStartOf(seoulDate(now));
        const filter = { userId: owner, weekStart };
        const update = {
            $set: { targetMin: Math.max(0, Math.min(MAX_TARGET_MIN, dto.targetMin)), notify80: dto.notify80 },
        };

        let saved: GoalLean | null;
        try {
            saved = await this.goalModel
                .findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' })
                .lean<GoalLean>();
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
            // 거의 동시에 두 번 눌러 한쪽이 unique 인덱스에 막힌 경우: 이미 만들어진 목표를 바꾼다
            saved = await this.goalModel.findOneAndUpdate(filter, update, { returnDocument: 'after' }).lean<GoalLean>();
        }
        return toGoalView(weekStart, saved, await this.recentAvgMin(owner, weekStart));
    }

    /**
     * 그 주의 목표. 이번 주에 정한 게 없으면 가장 최근에 정한 목표를 이어받는다
     * (앱 mock이 목표를 주와 상관없이 유지하기 때문. FR-06-24의 "매주 새로 시작" 해석은 앱 담당과 확인)
     */
    private async findGoal(owner: Types.ObjectId, weekStart: string): Promise<GoalLean | null> {
        const own = await this.goalModel.findOne({ userId: owner, weekStart }).lean<GoalLean>();
        if (own) return own;
        return this.goalModel
            .findOne({ userId: owner, weekStart: { $lt: weekStart } })
            .sort({ weekStart: -1 })
            .lean<GoalLean>();
    }

    /** 이번 주를 뺀 최근 4주의 주간 순공 평균(분) */
    private async recentAvgMin(owner: Types.ObjectId, weekStart: string): Promise<number> {
        const totals = await this.dayTotals(owner, addDays(weekStart, -28), addDays(weekStart, -1));
        let sec = 0;
        for (let w = 1; w <= 4; w++) sec += sumRange(totals, addDays(weekStart, -7 * w), 7);
        return Math.round(sec / 4 / 60);
    }

    /**
     * from~to(포함) 날짜별 하루 순공 초.
     * 자정 분할 · 하루 16시간 상한 · 어뷰징(24시간 이상) 제외는 session의 세션 종료 때 이미 적용돼 totalSec에 들어 있어 다시 계산하지 않는다
     */
    private async dayTotals(owner: Types.ObjectId, from: string, to: string): Promise<Map<string, number>> {
        const docs = await this.dailyModel
            .find({ userId: owner, studyDate: { $gte: from, $lte: to } }, { studyDate: 1, totalSec: 1 })
            .lean<DayTotalLean[]>();
        return new Map(docs.map((doc) => [doc.studyDate, doc.totalSec]));
    }
}

function toGoalView(weekStart: string, goal: GoalLean | null, recentAvgMin: number): WeeklyGoalView {
    const own = goal !== null && goal.weekStart === weekStart;
    return {
        // 이번 주에 직접 정한 목표가 없으면(없음/이어받음) 앱 mock처럼 주 이름으로 대신한다
        _id: own ? goal._id.toString() : `wg-${weekStart}`,
        weekStart,
        targetMin: goal?.targetMin ?? DEFAULT_TARGET_MIN,
        notify80: goal?.notify80 ?? DEFAULT_NOTIFY80,
        recentAvgMin,
    };
}

function isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
