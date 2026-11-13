import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';

export const BOX_MAX_IDS = 200; // 한 번에 담거나 지우는 문제 수 상한

// POST /quiz-box { questionIds } · POST /quiz-box/delete { questionIds }
// id 형식이 틀린 것은 400이 아니라 "없는 문제"와 같게 404로 보내야 해서(서비스가 확인) 문자열인지만 본다
export class QuestionIdsDto {
    @IsArray()
    @ArrayMaxSize(BOX_MAX_IDS)
    @IsString({ each: true })
    @MaxLength(100, { each: true })
    questionIds!: string[];
}
