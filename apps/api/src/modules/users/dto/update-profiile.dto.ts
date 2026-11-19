import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsObject,
  IsString,
  ValidateIf,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 알림 조용한 시간(서울). 23:00~07:00처럼 자정을 넘어도 된다 */
class QuietHoursDto {
  @Matches(HHMM) start!: string;
  @Matches(HHMM) end!: string;
}

class UpdateSettingsDto {
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() resumePlayback?: boolean;
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  keepScreenOnWhileRecording?: boolean;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(50)
  subtitleLanguage?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['swipe', 'scroll', 'tap'])
  pageTurn?: string;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() offlineCache?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsIn(['light', 'dark']) theme?: string;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() doubleTapEraser?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() leftHanded?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() notifyFriend?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() notifyChat?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() notifyRoom?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() notifyStudy?: boolean;
  @ValidateIf((_object, value) => value !== undefined) @IsBoolean() notifyAi?: boolean;
  /** null이면 조용한 시간을 끈다 */
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => QuietHoursDto)
  quietHours?: QuietHoursDto | null;
  /** 알림을 끈 채팅방 id 전체(통째로 바꾼다) */
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsMongoId({ each: true })
  mutedChatRoomIds?: string[];
}

export class UpdateProfileDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(10)
  @Matches(/^[가-힣a-zA-Z0-9]+$/)
  nickname?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['middle_high', 'university', 'worker'])
  learnerType?: string;

  /** 학교 · 학년: 본인 인증 없이 바꾼다. 빈 글이면 지운다(앞뒤 공백은 저장할 때 지운다) */
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(40)
  school?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(10)
  grade?: string;

  /** 처음 안내를 마쳤으면 true, 처음 설정을 막 마쳐 아직 안내 전이면 false */
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  toured?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  interestCategoryIds?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => UpdateSettingsDto)
  settings?: UpdateSettingsDto;
}
