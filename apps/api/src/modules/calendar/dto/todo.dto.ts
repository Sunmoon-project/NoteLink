import { IsBoolean, IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const TODO_TYPES = ['general', 'assignment', 'exam'] as const;
export type TodoType = (typeof TODO_TYPES)[number];

export const TIME_SLOTS = ['none', 'am', 'pm', 'custom'] as const;
export type TimeSlot = (typeof TIME_SLOTS)[number];

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// GET /todos?date=YYYY-MM-DD
export class TodosQueryDto {
    @Matches(YMD)
    @IsISO8601({ strict: true }) // 2월 31일 같은 없는 날짜는 거부한다
    date!: string;
}

// POST /todos { content, todoType, dueDate, timeSlot, dueTime?, subjectName }
export class CreateTodoDto {
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    content!: string;

    @IsIn(TODO_TYPES)
    todoType!: TodoType;

    @Matches(YMD)
    @IsISO8601({ strict: true })
    dueDate!: string;

    @IsIn(TIME_SLOTS)
    timeSlot!: TimeSlot;

    // 시각을 직접 고른 경우의 'HH:mm'
    @IsOptional()
    @Matches(HHMM)
    dueTime?: string;

    // 과목 이름. 목록에 없거나 비어 있으면 과목 없이 만든다
    @IsOptional()
    @IsString()
    @MaxLength(20)
    subjectName?: string | null;
}

// PATCH /todos/:id { done }
export class ToggleTodoDto {
    @IsBoolean()
    done!: boolean;
}

// POST /ddays { title, date }
export class CreateDdayDto {
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    title!: string;

    @Matches(YMD)
    @IsISO8601({ strict: true })
    date!: string;
}
