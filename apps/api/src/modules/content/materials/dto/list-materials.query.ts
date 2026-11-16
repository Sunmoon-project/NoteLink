import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { LIST_LIMIT_MAX, LIST_LIMIT_MIN } from '../list-cursor.js';

/** GET /folders/:id/materials 의 선택 쿼리. 둘 다 없으면 전체 배열(기존 앱 호환) */
export class ListMaterialsQuery {
  /** 한 번에 받을 개수(1~100). 있으면 다음 페이지가 있을 때 응답 헤더 X-Next-Cursor 를 준다 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(LIST_LIMIT_MIN)
  @Max(LIST_LIMIT_MAX)
  limit?: number;

  /** 이전 응답의 X-Next-Cursor 값(limit 과 함께) */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
