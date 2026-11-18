import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

import { SHARE_MODES, type ShareMode } from '../../calendar/schemas/timetable-share.schema.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// POST /timetable/classes { subjectName, days, startTime, endTime, location, color }
export class AddClassDto {
    @IsString()
    @MinLength(1)
    @MaxLength(30)
    subjectName!: string;

    @IsArray()
    @ArrayMinSize(1)
    @ArrayUnique()
    @IsInt({ each: true })
    @Min(0, { each: true })
    @Max(6, { each: true })
    days!: number[]; // 0=일 ... 6=토

    @Matches(HHMM)
    startTime!: string;

    @Matches(HHMM)
    endTime!: string;

    // 장소는 선택이라 없으면 빈 글자로 저장한다
    @IsOptional()
    @IsString()
    @MaxLength(30)
    location?: string;

    @Matches(/^#[0-9a-fA-F]{6}$/)
    color!: string;
}

// POST /timetable/shares { friendIds, mode }
export class ShareTimetableDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(50)
    @ArrayUnique()
    @IsMongoId({ each: true })
    friendIds!: string[]; // 친구의 사용자 id

    @IsIn(SHARE_MODES)
    mode!: ShareMode;
}
