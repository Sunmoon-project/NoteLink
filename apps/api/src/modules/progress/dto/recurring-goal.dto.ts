import {
    ArrayNotEmpty,
    ArrayUnique,
    IsArray,
    IsBoolean,
    IsInt,
    IsISO8601,
    IsMongoId,
    IsNumber,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
    ValidateIf,
} from 'class-validator';

const PAUSED_UNTIL = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/;

// 값이 아예 없을 때(undefined)만 검사를 건너뛴다. null은 건너뛰지 않고 검사해서 거부한다
const whenSent = () => ValidateIf((_obj, value) => value !== undefined);

// POST /goals/recurring 와 PATCH /goals/recurring/:id 가 함께 쓴다.
// 만들 때는 name · days가 꼭 있어야 하고(서비스가 확인), 나머지는 없으면 기본값. 고칠 때는 보낸 필드만 바꾼다
export class SaveRecurringGoalDto {
    @whenSent()
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name?: string;

    // 요일 0(일)~6(토), 중복 없이, 하나 이상 (FR-11-04)
    @whenSent()
    @IsArray()
    @ArrayNotEmpty()
    @ArrayUnique()
    @IsInt({ each: true })
    @Min(0, { each: true })
    @Max(6, { each: true })
    days?: number[];

    // 하루 목표 분. 최소 10분 (FR-11-05)
    @whenSent()
    @IsInt()
    @Min(10)
    @Max(24 * 60)
    targetMin?: number;

    // 과목 id 또는 null
    @IsOptional()
    @IsMongoId()
    subjectId?: string | null;

    @whenSent()
    @IsBoolean()
    remindEnabled?: boolean;

    // 'HH:mm' 또는 null
    @IsOptional()
    @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
    remindTime?: string | null;

    // null, 'YYYY-MM-DD'(서울 자정), 또는 시간대가 붙은 ISO 일시(Z · +09:00). 시간대 없는 일시는 서버 시간대에 따라 달라지므로 거부한다
    @IsOptional()
    @Matches(PAUSED_UNTIL)
    @IsISO8601({ strict: true })
    pausedUntil?: string | null;

    @whenSent()
    @IsBoolean()
    isActive?: boolean;

    // 앱이 목표 전체를 그대로 보내므로 받기만 하고 무시한다 (서버가 정하는 값)
    @whenSent()
    @IsString()
    _id?: string;

    @whenSent()
    @IsNumber()
    streak?: number;
}
