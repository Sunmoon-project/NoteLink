import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

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

  // GET /study-rooms?mine=true — 내가 참여 중인 방
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true')
  @IsBoolean()
  mine?: boolean;

  // GET /study-rooms?recommended=true — 공개방 (지금은 기본 목록과 같음)
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true')
  @IsBoolean()
  recommended?: boolean;
}
