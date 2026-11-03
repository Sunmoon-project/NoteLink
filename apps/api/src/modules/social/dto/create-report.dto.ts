import {
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 신고 접수 (발표자료 p.78 "10. 신고 내용 입력") */
export class CreateReportDto {
  @IsMongoId() roomId: string;
  @IsMongoId() targetUserId: string;
  @IsIn(['chat', 'profile', 'behavior']) reportType: string;

  @IsString() @MinLength(1) @MaxLength(500) details: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true }) // 배열의 각 원소가 문자열(URL)이어야 함
  imageUrls?: string[];
}
