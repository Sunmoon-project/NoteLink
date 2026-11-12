import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import type { SaveRecurringGoalDto } from './dto/recurring-goal.dto.js';
import { RecurringGoal } from './schemas/recurring-goal.schema.js';

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

type GoalLean = RecurringGoal & { _id: Types.ObjectId };

const NOT_FOUND = { code: 'NOT_FOUND', message: '존재하지 않는 반복 목표입니다.' };
const DEFAULT_TARGET_MIN = 30; // 앱(local/api.ts)이 새 목표에 넣는 값

@Injectable()
export class RecurringGoalsService {
    constructor(@InjectModel(RecurringGoal.name) private readonly goalModel: Model<RecurringGoal>) { }

    /** 내 반복 목표 (지운 것 제외), 만든 순서 */
    async list(userId: string): Promise<RecurringGoalView[]> {
        const docs = await this.goalModel
            .find({ userId: new Types.ObjectId(userId), deletedAt: null })
            .sort({ createdAt: 1, _id: 1 })
            .lean<GoalLean[]>();
        return docs.map(toView);
    }

    /** 만든다. 이름과 요일은 꼭 있어야 하고, 나머지는 앱과 같은 기본값 */
    async create(userId: string, dto: SaveRecurringGoalDto): Promise<RecurringGoalView> {
        if (dto.name === undefined || dto.days === undefined) {
            throw new BadRequestException({ code: 'VALIDATION_ERROR', message: '목표 이름과 요일이 필요합니다.' });
        }
        const created = await this.goalModel.create({
            targetMin: DEFAULT_TARGET_MIN,
            remindEnabled: false,
            isActive: true,
            ...toFields(dto),
            userId: new Types.ObjectId(userId),
            name: dto.name,
            days: sortedDays(dto.days),
        });
        return toView(created.toObject() as unknown as GoalLean);
    }

    /** 보낸 필드만 바꾼다. 남의 목표 · 지운 목표 · 없는 목표는 404 */
    async update(userId: string, id: string, dto: SaveRecurringGoalDto): Promise<RecurringGoalView> {
        const fields = toFields(dto);
        if (dto.name !== undefined) fields['name'] = dto.name;
        if (dto.days !== undefined) fields['days'] = sortedDays(dto.days);
        const saved = await this.goalModel
            .findOneAndUpdate(ownedAlive(userId, id), { $set: fields }, { returnDocument: 'after' })
            .lean<GoalLean>();
        if (!saved) throw new NotFoundException(NOT_FOUND);
        return toView(saved);
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

const sortedDays = (days: number[]) => [...days].sort((a, b) => a - b);

/** 보낸 값 중 바꿀 수 있는 것만 저장 모양으로 (서버가 정하는 _id · streak은 버린다. 이름 · 요일은 호출한 쪽이 넣는다) */
function toFields(dto: SaveRecurringGoalDto): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    if (dto.targetMin !== undefined) fields['targetMin'] = dto.targetMin;
    if (dto.subjectId !== undefined) fields['subjectId'] = dto.subjectId === null ? null : new Types.ObjectId(dto.subjectId);
    if (dto.remindEnabled !== undefined) fields['remindEnabled'] = dto.remindEnabled;
    if (dto.remindTime !== undefined) fields['remindTime'] = dto.remindTime;
    if (dto.pausedUntil !== undefined) fields['pausedUntil'] = dto.pausedUntil === null ? null : new Date(dto.pausedUntil);
    if (dto.isActive !== undefined) fields['isActive'] = dto.isActive;
    return fields;
}

function toView(goal: GoalLean): RecurringGoalView {
    return {
        _id: goal._id.toString(),
        name: goal.name,
        days: goal.days,
        targetMin: goal.targetMin,
        subjectId: goal.subjectId ? goal.subjectId.toString() : null,
        remindEnabled: goal.remindEnabled,
        remindTime: goal.remindTime ?? null,
        pausedUntil: goal.pausedUntil ? goal.pausedUntil.toISOString() : null,
        // TODO: 달성 판정 · streak 계산(FR-11-06 · 11)은 판정 PR에서 채운다. 지금은 항상 0
        streak: 0,
        isActive: goal.isActive,
    };
}
