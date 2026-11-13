import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** 앞뒤 공백을 지운다. 공백뿐인 글은 빈 글이 되어 IsNotEmpty에서 걸린다 */
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export const FLASHCARD_FRONT_MAX = 1000;
export const FLASHCARD_BACK_MAX = 2000;
/** 한 번에 지울 수 있는 카드 수 */
export const FLASHCARD_DELETE_MAX = 200;

// POST /flashcards { front, back, sourceQuestionId? }
export class SaveFlashcardDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FLASHCARD_FRONT_MAX)
  front!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(FLASHCARD_BACK_MAX)
  back!: string;

  // 없거나 null이면 문제 없이 저장한다. 있으면 형식이 맞아야 한다(틀리면 400)
  @IsOptional()
  @IsMongoId()
  sourceQuestionId?: string | null;
}

// POST /flashcards/delete { ids }
// 없거나 남의 카드 id는 조용히 넘어가므로(앱과 같게) id 형식은 보지 않고 문자열 배열인지만 본다
export class DeleteFlashcardsDto {
  @IsArray()
  @ArrayMaxSize(FLASHCARD_DELETE_MAX)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  ids!: string[];
}
