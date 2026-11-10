import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * 공개 스터디룸 목록 조회 (발표자료 p.75 "1. 스터디룸 탭 최초 화면")
 * 쿼리 파라미터로 받습니다: GET /study-rooms?limit=20
 */
export class ListStudyRoomsDto {
  // 쿼리 문자열은 문자열로 오므로 숫자로 변환합니다.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
