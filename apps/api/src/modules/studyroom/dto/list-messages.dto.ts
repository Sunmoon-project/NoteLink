import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';

/**
 * 채팅 히스토리 조회 (무한 스크롤).
 * GET /study-rooms/:id/messages?limit=30&before=<메시지 id>
 */
export class ListMessagesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // 이 메시지 id보다 "이전" 메시지를 가져옵니다(커서). 없으면 최신부터.
  @IsOptional()
  @IsMongoId()
  before?: string;
}
