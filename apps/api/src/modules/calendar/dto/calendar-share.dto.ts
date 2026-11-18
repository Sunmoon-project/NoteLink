import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsISO8601, IsOptional, Matches, Max, Min, ValidateIf } from 'class-validator';

export const SHARE_SCOPES = ['todos', 'study'] as const; // 공유할 내용: 할 일 / 공부 기록
export type ShareScope = (typeof SHARE_SCOPES)[number];
export const DEFAULT_SHARE_SCOPES = SHARE_SCOPES; // 안 보내면 할 일과 공부 기록 둘 다

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// POST /calendar-shares { rangeStart, rangeEnd, expiresInDays, scopes? }
export class CreateCalendarShareDto {
    @Matches(YMD)
    @IsISO8601({ strict: true })
    rangeStart!: string;

    @Matches(YMD)
    @IsISO8601({ strict: true })
    rangeEnd!: string;

    // 1일·7일 같은 일수, 무제한이면 null (보내지 않으면 400)
    @ValidateIf((o: CreateCalendarShareDto) => o.expiresInDays !== null)
    @IsInt()
    @Min(1)
    @Max(365)
    expiresInDays!: number | null;

    // 공유할 내용. 안 보내면 할 일과 공부 기록 둘 다
    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @ArrayUnique()
    @IsIn(SHARE_SCOPES, { each: true })
    scopes?: ShareScope[];
}
