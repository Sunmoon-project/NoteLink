import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { daysBetween } from '../progress/week.js';
import { Subject } from '../session/schemas/subject.schema.js';
import { seoulDate } from '../session/study-time.js';
import type { CreateDdayDto, CreateTodoDto, TimeSlot, TodoType } from './dto/todo.dto.js';
import { Todo, type TodoDocument } from './schemas/todo.schema.js';

/** 앱에 내려주는 할 일 (shared Todo) */
export interface TodoView {
    _id: string;
    dueDate: string;
    content: string;
    todoType: TodoType;
    isDday: boolean;
    timeSlot: TimeSlot;
    dueTime: string | null;
    subjectId: string | null;
    subjectName?: string;
    done: boolean;
    doneAt: string | null;
    createdAt: string;
}

/** 앱에 내려주는 D-day (shared DDay) */
export interface DdayView {
    _id: string;
    title: string;
    date: string;
    source: 'todo' | 'manual';
    kind: string;
    daysLeft: number;
}

type TodoLean = Todo & { _id: Types.ObjectId; createdAt: Date };

const NOT_FOUND = { code: 'NOT_FOUND', message: '존재하지 않는 할 일입니다.' };
// 앱(local/api.ts)과 같은 이름: 시험 · 과제, 직접 만든 D-day는 목표일
const KIND: Record<TodoType, string> = { exam: '시험', assignment: '과제', general: '목표일' };

@Injectable()
export class CalendarService {
    constructor(
        @InjectModel(Todo.name) private readonly todoModel: Model<Todo>,
        @InjectModel(Subject.name) private readonly subjectModel: Model<Subject>,
        @InjectConnection() private readonly connection: Connection,
    ) { }

    /** 그날 할 일 목록 (D-day 목록용 건은 빼고, 만든 순서) */
    async todos(userId: string, date: string): Promise<TodoView[]> {
        const docs = await this.todoModel
            .find({ userId: new Types.ObjectId(userId), dueDate: date, isDday: false })
            .sort({ createdAt: 1, _id: 1 })
            .lean<TodoLean[]>();
        return docs.map(toTodoView);
    }

    /** 할 일을 만든다. 과제 · 시험이면 D-day 목록에 보일 짝도 함께 만든다 (일반 할 일은 한 건) */
    async addTodo(userId: string, dto: CreateTodoDto): Promise<TodoView> {
        const subject = dto.subjectName
            ? await this.subjectModel.findOne({ name: dto.subjectName, isActive: true }).lean<Subject & { _id: Types.ObjectId }>()
            : null;
        const base = {
            userId: new Types.ObjectId(userId),
            dueDate: dto.dueDate,
            content: dto.content,
            todoType: dto.todoType,
            timeSlot: dto.timeSlot,
            dueTime: dto.timeSlot === 'custom' ? dto.dueTime : undefined, // 비우면 스키마 기본값 null
            subjectId: subject?._id ?? null,
            subjectName: dto.subjectName || null,
        };

        // 과제 · 시험의 두 건은 한 트랜잭션으로 만든다: 둘 다 생기거나 둘 다 안 생긴다 (일반 할 일은 한 건)
        const pairId = dto.todoType === 'general' ? null : new Types.ObjectId();
        const docs = pairId
            ? [{ ...base, isDday: false, pairId }, { ...base, isDday: true, pairId }]
            : [{ ...base, isDday: false }];
        const dayItem = await this.connection.transaction(async (session) => {
            let first: TodoDocument | undefined;
            for (const doc of docs) {
                const [created] = await this.todoModel.create([doc], { session });
                first ??= created;
            }
            return first;
        });
        return toTodoView(requireCreated(dayItem));
    }

    /** 완료 표시를 바꾼다. 짝이 있으면(과제 · 시험) D-day 쪽도 같이 바꿔서 완료한 과제는 D-day 목록에서 빠진다 */
    async setDone(userId: string, id: string, done: boolean): Promise<void> {
        const owner = new Types.ObjectId(userId);
        // 찾기와 바꾸기를 한 트랜잭션으로: 짝이 함께 바뀌거나 아무것도 안 바뀐다
        await this.connection.transaction(async (session) => {
            const found = await this.todoModel
                .findOne({ _id: toObjectId(id), userId: owner }, null, { session })
                .lean<TodoLean>();
            if (!found) throw new NotFoundException(NOT_FOUND);

            const filter = found.pairId ? { userId: owner, pairId: found.pairId } : { _id: found._id, userId: owner };
            await this.todoModel.updateMany(filter, { $set: { done, doneAt: done ? new Date() : null } }, { session });
        });
    }

    /** D-day 목록: 안 끝낸 과제 · 시험과 직접 만든 D-day. 남은 일수가 적은 순, 지난 날짜는 지우지 않고 맨 뒤 */
    async ddays(userId: string, now = new Date()): Promise<DdayView[]> {
        const today = seoulDate(now);
        const docs = await this.todoModel
            .find({ userId: new Types.ObjectId(userId), isDday: true, done: false })
            .lean<TodoLean[]>();
        return docs
            .map((t): DdayView => ({
                _id: t._id.toString(),
                title: t.content,
                date: t.dueDate,
                source: t.todoType === 'general' ? 'manual' : 'todo',
                kind: KIND[t.todoType as TodoType] ?? KIND.assignment,
                daysLeft: daysBetween(today, t.dueDate),
            }))
            .sort(compareDday);
    }

    /** 직접 D-day를 만든다 (D-day 목록에만 보이는 한 건) */
    async addDday(userId: string, dto: CreateDdayDto, now = new Date()): Promise<DdayView> {
        const [created] = await this.todoModel.create([
            {
                userId: new Types.ObjectId(userId),
                dueDate: dto.date,
                content: dto.title,
                todoType: 'general',
                isDday: true,
                timeSlot: 'none',
            },
        ]);
        return {
            _id: requireCreated(created)._id.toString(),
            title: dto.title,
            date: dto.date,
            source: 'manual',
            kind: KIND.general,
            daysLeft: daysBetween(seoulDate(now), dto.date),
        };
    }
}

/** 오늘 이후(0 포함)는 적은 순, 지난 날짜(음수)는 그 뒤에 가장 최근에 지난 것부터 */
function compareDday(a: DdayView, b: DdayView): number {
    const aPast = a.daysLeft < 0;
    const bPast = b.daysLeft < 0;
    if (aPast !== bPast) return aPast ? 1 : -1;
    return aPast ? b.daysLeft - a.daysLeft : a.daysLeft - b.daysLeft;
}

/** create가 돌려준 문서를 읽기용 모양으로 (배열 첫 칸은 타입상 없을 수도 있어서 확인한다) */
function requireCreated(doc: TodoDocument | undefined): TodoLean {
    if (!doc) throw new Error('할 일이 만들어지지 않았습니다.');
    return doc.toObject() as unknown as TodoLean;
}

/** id 모양이 틀리면 아무것도 못 찾게 한다 (→ 404) */
function toObjectId(id: string): Types.ObjectId {
    return /^[0-9a-f]{24}$/i.test(id) ? new Types.ObjectId(id) : new Types.ObjectId('000000000000000000000000');
}

function toTodoView(t: TodoLean): TodoView {
    return {
        _id: t._id.toString(),
        dueDate: t.dueDate,
        content: t.content,
        todoType: t.todoType as TodoType,
        isDday: t.isDday,
        timeSlot: (t.timeSlot ?? 'none') as TimeSlot,
        dueTime: t.dueTime ?? null,
        subjectId: t.subjectId ? t.subjectId.toString() : null,
        ...(t.subjectName ? { subjectName: t.subjectName } : {}),
        done: t.done,
        doneAt: t.doneAt ? t.doneAt.toISOString() : null,
        createdAt: t.createdAt.toISOString(),
    };
}
