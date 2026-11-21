import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsMongoId, ValidateIf } from 'class-validator';

/** 한 번에 방에 공유할 수 있는 플래시카드 수 */
export const SHARE_MAX_FLASHCARDS = 100;

/** POST /study-rooms/:id/shared-items 본문: 내 퀴즈 하나 또는 고른 플래시카드들(#481) */
export class ShareStudyItemDto {
  @IsIn(['quiz', 'flashcards']) kind: 'quiz' | 'flashcards';

  @ValidateIf((o: ShareStudyItemDto) => o.kind === 'quiz')
  @IsMongoId()
  quizSetId?: string;

  @ValidateIf((o: ShareStudyItemDto) => o.kind === 'flashcards')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHARE_MAX_FLASHCARDS)
  @IsMongoId({ each: true })
  flashcardIds?: string[];
}
