import { IsMongoId, IsNotEmpty, IsString, MaxLength } from 'class-validator';

// POST /quiz-attempts { quizSetId }
// id 형식이 틀린 것은 400이 아니라 "없는 세트"와 같게 404로 보내야 해서(서비스가 확인) 문자열인지만 본다
export class StartAttemptDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    quizSetId!: string;
}

// POST /quiz-attempts/:id/answers { questionId, answer }
export class SubmitAnswerDto {
    @IsMongoId()
    questionId!: string;

    // 정답 글은 처리기가 만든 짧은 글이라 넉넉한 상한만 둔다
    @IsString()
    @MaxLength(2000)
    answer!: string;
}
