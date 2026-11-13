import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

/**
 * 한 번에 담거나 지우는 문제 수 상한. 앱은 고른 문제를 개수 제한 없이 한 번에 보내서 많이 골라도 400이 되지 않게 넉넉히 잡되,
 * Express 기본 본문 제한(100KB) 안에 들어와야 한다: id 하나가 약 27바이트(24자리 + 따옴표 둘 + 쉼표)라 3000개면 약 81KB
 */
export const BOX_MAX_IDS = 3000;

// POST /quiz-box { questionIds } · POST /quiz-box/delete { questionIds }
// id 형식이 틀린 것은 400이 아니라 "없는 문제"와 같게 404로 보내야 해서(서비스가 확인) 문자열인지만 본다
export class QuestionIdsDto {
    @IsArray()
    @ArrayMaxSize(BOX_MAX_IDS)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    questionIds!: string[];
}
