import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { StudySession } from '../session/schemas/study-session.schema.js';
import { seoulDate } from '../session/study-time.js';
import type { SetWeeklyGoalDto } from './dto/set-weekly-goal.dto.js';
import type { StatsRange } from './dto/study-query.dto.js';
import { DailyRecord } from './schemas/daily-record.schema.js';
import { WeeklyGoal } from './schemas/weekly-goal.schema.js';
import { isStreakDay, levelOf, longestStreak, peakHour } from './stats.js';
import { addDays, daysBetween, sumRange, weekStartOf } from './week.js';

/** 앱에 내려주는 이번 주 목표 (공유 계약 WeeklyGoal) */
export interface WeeklyGoalView {
    _id: string;
    weekStart: string;
    targetMin: number;
    notify80: boolean;
    recentAvgMin: number;
}

/** 앱에 내려주는 이번 주 요약 (공유 계약 WeeklySummary) */
export interface WeeklySummaryView {
    weekStart: string;
    totalSec: number;
    diffFromLastWeekSec: number;
    goalMin: number;
    days: { studyDate: string; totalSec: number }[];
}

/** 월간 캘린더 한 칸 (앱 MonthDay) */
export interface MonthDayView {
    studyDate: string;
    level: number;
    hasTodo: boolean;
}

/** 누적 기록 (공유 계약 StudyStats) */
export interface StudyStatsView {
    totalSec: number;
    studyDays: number;
    longestStreak: number;
    peakHour: number;
    heatmap: { studyDate: string; level: number }[];
}

const HEATMAP_DAYS = 126; // 18주 (앱과 같다)
// 연속 학습일을 셀 때 한 번에 읽는 하루 기록 수. 연속이 이보다 길면 다음 묶음을 이어서 읽는다
export const STREAK_BATCH_SIZE = 30;
// 오늘을 포함해 며칠인지 (앱: 90d는 오늘-89일부터, 30d는 오늘-29일부터). all은 처음 기록부터 오늘까지
const RANGE_DAYS: Record<StatsRange, number | null> = { all: null, '90d': 90, '30d': 30 };

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
        @InjectModel(StudySession.name) private readonly sessionModel: Model<StudySession>,
    ) { }

    /** 이번 주(월~일) 요약: 합계, 지난주 같은 요일까지와의 차이, 요일별 시간, 목표 */
    async weekly(userId: string, now = new Date()): Promise<WeeklySummaryView> {
        const owner = new Types.ObjectId(userId);
        const today = seoulDate(now);
        const weekStart = weekStartOf(today);
        const lastStart = addDays(weekStart, -7);

        const [totals, goal] = await Promise.all([
            this.dayTotals(owner, lastStart, addDays(weekStart, 6)),
            this.findGoal(owner, weekStart),
        ]);

        const passed = daysBetween(weekStart, today) + 1; // 월요일부터 오늘까지 며칠
        return {
            weekStart,
            totalSec: sumRange(totals, weekStart, 7),
            // 지난주 전체가 아니라 지난주 같은 요일까지와 비교한다
            diffFromLastWeekSec: sumRange(totals, weekStart, passed) - sumRange(totals, lastStart, passed),
            goalMin: goal?.targetMin ?? DEFAULT_TARGET_MIN,
            days: Array.from({ length: 7 }, (_, i) => {
                const studyDate = addDays(weekStart, i);
                return { studyDate, totalSec: totals.get(studyDate) ?? 0 };
            }),
        };
    }

    /** 그 달 모든 날짜의 색 진하기 (ym은 'YYYY-MM') */
    async month(userId: string, ym: string): Promise<MonthDayView[]> {
        const owner = new Types.ObjectId(userId);
        const [year, month] = ym.split('-').map(Number) as [number, number];
        const length = new Date(Date.UTC(year, month, 0)).getUTCDate(); // 28 ~ 31
        const first = `${ym}-01`;
        const totals = await this.dayTotals(owner, first, addDays(first, length - 1));
        return Array.from({ length }, (_, i) => {
            const studyDate = addDays(first, i);
            // hasTodo는 할 일(FR-10) PR에서 todos와 연결한다. 그때까지는 항상 false
            return { studyDate, level: levelOf(totals.get(studyDate) ?? 0), hasTodo: false };
        });
    }

    /**
     * 기간별 누적 기록. 합계 · 공부한 날 · 최장 연속은 daily_records의 날짜별 순공(서울 기준)에서 구하고,
     * 가장 많이 공부한 시간대는 끝난 세션 중 어뷰징이 아닌 것의 시작 시각(서울)으로 구한다.
     * 잔디(heatmap)는 기간과 상관없이 오늘까지 최근 126일이다
     */
    async stats(userId: string, range: StatsRange, now = new Date()): Promise<StudyStatsView> {
        const owner = new Types.ObjectId(userId);
        const today = seoulDate(now);
        const spanDays = RANGE_DAYS[range];
        const from = spanDays === null ? null : addDays(today, -(spanDays - 1));
        const heatFrom = addDays(today, -(HEATMAP_DAYS - 1));
        // 합계 기간과 잔디 중 더 긴 쪽을 한 번에 읽는다
        const readFrom = from === null ? '0000-01-01' : from < heatFrom ? from : heatFrom;

        const [totals, sessions] = await Promise.all([
            this.dayTotals(owner, readFrom, today),
            this.sessionModel
                .find(
                    {
                        userId: owner,
                        status: 'ended',
                        isAbuse: { $ne: true },
                        ...(from === null ? {} : { studyDate: { $gte: from } }),
                    },
                    { startedAt: 1, durationSec: 1 },
                )
                .lean<{ startedAt: Date; durationSec: number }[]>(),
        ]);

        let totalSec = 0;
        const okDays = new Set<string>();
        for (const [day, sec] of totals) {
            if (from !== null && day < from) continue;
            totalSec += sec;
            if (isStreakDay(sec)) okDays.add(day);
        }
        return {
            totalSec,
            studyDays: okDays.size,
            longestStreak: longestStreak(okDays),
            peakHour: peakHour(sessions),
            heatmap: Array.from({ length: HEATMAP_DAYS }, (_, i) => {
                const studyDate = addDays(heatFrom, i);
                return { studyDate, level: levelOf(totals.get(studyDate) ?? 0) };
            }),
        };
    }

    /**
     * 지금 이어지는 연속 학습일 (GET /users/me 의 streakDays). 하루 순공 10분 이상인 날이 이어진 일수이고,
     * 오늘 아직 못 채웠으면(기록이 없거나 10분 미만) 어제까지의 연속을 센다. 하루라도 비면 끊긴다.
     * 날짜별 순공은 daily_records(서울 기준)에서 최근 날짜부터 batchSize건씩만 읽고, 첫 공백에서 멈춘다
     * (이미 끊긴 오래된 기록은 읽지 않는다). (userId, studyDate) 인덱스를 쓴다
     */
    async streakDays(userId: string, now = new Date(), batchSize = STREAK_BATCH_SIZE): Promise<number> {
        const owner = new Types.ObjectId(userId);
        const today = seoulDate(now);
        let expected = today; // 다음에 나와야 하는 날짜 (이 날짜가 10분 이상이면 연속이 이어진다)
        let graceLeft = true; // 오늘은 아직 안 채워도 끊기지 않는다 (한 번만)
        let count = 0;
        let cursor: string | null = null; // 지금까지 읽은 가장 오래된 날짜

        for (;;) {
            const docs: DayTotalLean[] = await this.dailyModel
                .find(
                    { userId: owner, studyDate: cursor === null ? { $lte: today } : { $lt: cursor } },
                    { studyDate: 1, totalSec: 1 },
                )
                .sort({ studyDate: -1 })
                .limit(batchSize)
                .lean<DayTotalLean[]>();

            for (const doc of docs) {
                if (graceLeft && doc.studyDate < expected) {
                    // 오늘 기록이 아예 없다 → 어제부터 센다
                    graceLeft = false;
                    expected = addDays(expected, -1);
                }
                if (doc.studyDate !== expected) return count; // 하루가 비었다
                if (isStreakDay(doc.totalSec)) {
                    count++;
                    expected = addDays(expected, -1);
                    graceLeft = false;
                } else if (graceLeft) {
                    // 오늘 기록은 있지만 10분 미만 → 어제부터 센다
                    graceLeft = false;
                    expected = addDays(expected, -1);
                } else {
                    return count; // 10분 미만인 날에서 끊긴다
                }
            }

            if (docs.length < batchSize) return count; // 더 오래된 기록이 없다
            cursor = docs[docs.length - 1]!.studyDate;
        }
    }

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
