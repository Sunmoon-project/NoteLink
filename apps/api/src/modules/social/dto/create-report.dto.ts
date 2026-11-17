import {
  IsArray,
  ArrayMaxSize,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsUrl,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { REPORT_TYPES } from '../report.constants.js';
import type { ReportType } from '../report.constants.js';

/** 신고 접수 (발표자료 p.78 "10. 신고 내용 입력") */
export class CreateReportDto {
  @IsMongoId() roomId: string;
  @IsMongoId() targetUserId: string;

  // 공용 스키마 ReportType: abusive_language · spam · disturbing · obscene · other
  @IsIn(REPORT_TYPES) reportType: ReportType;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  details: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true, require_tld: false },
    { each: true },
  )
  imageUrls?: string[];
}
