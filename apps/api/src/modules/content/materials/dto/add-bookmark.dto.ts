import { IsNumber, Max, Min } from 'class-validator';

/** 북마크 시각의 상한(초): 24시간 */
export const BOOKMARK_AT_MAX_SEC = 86400;

/** POST /materials/:id/bookmarks 본문: `{ atSec }` 만 받는다(다른 필드는 전역 검증이 400 으로 거절) */
export class AddBookmarkDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(BOOKMARK_AT_MAX_SEC)
  atSec: number;
}
