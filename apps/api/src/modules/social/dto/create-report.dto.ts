import { IsArray, IsIn, IsMongoId, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { REPORT_TYPES } from '../report.constants.js';
import type { ReportType } from '../report.constants.js';

/** 신고 접수 (발표자료 p.78 "10. 신고 내용 입력") */
export class CreateReportDto {
  @IsMongoId() roomId: string;
  @IsMongoId() targetUserId: string;

  // 공용 스키마 ReportType: abusive_language · spam · disturbing · obscene · other
  @IsIn(REPORT_TYPES) reportType: ReportType;

  @IsString() @MinLength(1) @MaxLength(500) details: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true }) // 배열의 각 원소가 문자열(URL)이어야 함
  imageUrls?: string[];
}
