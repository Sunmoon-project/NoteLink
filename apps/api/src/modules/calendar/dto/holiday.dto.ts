import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// GET /holidays?year=2026 (없으면 서울 기준 올해)
export class HolidaysQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(2000)
    @Max(2100)
    year?: number;
}

// PATCH /holidays/:date { hidden } — 날짜는 주소에서 받는다
export class HolidayDateParamDto {
    @Matches(YMD)
    @IsISO8601({ strict: true }) // 2월 31일 같은 없는 날짜는 거부한다
    date!: string;
}

export class HideHolidayDto {
    @IsBoolean()
    hidden!: boolean;
}

// POST /holidays/custom { name, date }
export class CreateCustomHolidayDto {
    @IsString()
    @MinLength(1)
    @MaxLength(30)
    name!: string;

    @Matches(YMD)
    @IsISO8601({ strict: true })
    date!: string;
}
