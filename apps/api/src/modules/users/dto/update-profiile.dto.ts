import { Type } from 'class-transformer';
import {
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
