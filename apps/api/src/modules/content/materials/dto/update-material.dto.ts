import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** 요약 수정 상한 */
export const SUMMARY_MAX_SECTIONS = 50;
export const SUMMARY_HEADING_MAX = 100;
export const SUMMARY_BODY_MAX = 10000;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SummarySectionDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(SUMMARY_HEADING_MAX)
  heading: string;

  @IsString() @MaxLength(SUMMARY_BODY_MAX) body: string;
}

export class SummaryPatchDto {
  @IsArray()
  @ArrayMaxSize(SUMMARY_MAX_SECTIONS)
  @ValidateNested({ each: true })
  @Type(() => SummarySectionDto)
  sections: SummarySectionDto[];
}

/** PATCH /materials/:id 본문: `{ saved: true }` 또는 `{ summary: { sections } }` 중 하나 */
export class UpdateMaterialDto {
  @IsOptional() @IsIn([true]) saved?: true;

  @IsOptional()
  @ValidateNested()
  @Type(() => SummaryPatchDto)
  summary?: SummaryPatchDto;
}
