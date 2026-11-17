import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
  ValidateNested,
} from 'class-validator';

export class RoomTimerPeriodDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  start: string;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  end: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  label: string;
}

/** PUT /study-rooms/:id/timer-rule. 규칙은 방장이 저장하고 참여자에게 공유한다. */
export class SetRoomTimerDto {
  @IsBoolean()
  enabled: boolean;

  @IsIn(['pomodoro', 'period'])
  type: 'pomodoro' | 'period';

  @IsInt()
  @Min(1)
  @Max(240)
  focusMin: number;

  @IsInt()
  @Min(0)
  @Max(120)
  breakMin: number;

  @IsInt()
  @Min(1)
  @Max(24)
  repeat: number;

  @IsArray()
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => RoomTimerPeriodDto)
  periods: RoomTimerPeriodDto[];
}
