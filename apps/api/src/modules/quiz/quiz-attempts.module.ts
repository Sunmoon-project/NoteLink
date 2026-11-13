import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { RewardModule } from '../reward/reward.module.js';
import { QuizAttempt, QuizAttemptSchema } from './schemas/quiz-attempt.schema.js';
import { QuizSet, QuizSetSchema } from './schemas/quiz-set.schema.js';
import { QuizAttemptsController } from './quiz-attempts.controller.js';
import { QuizAttemptsService } from './quiz-attempts.service.js';

/** 퀴즈 풀이 시작 · 답 제출 채점(FR-49·50). 끝내기 · 정답 포인트(FR-51) */
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: QuizAttempt.name, schema: QuizAttemptSchema },
            { name: QuizSet.name, schema: QuizSetSchema }, // 내 세트인지 · 문제 정답을 읽기만 한다
            { name: User.name, schema: UserSchema }, // 끝낸 뒤 잔액을 읽기만 한다
        ]),
        RewardModule, // 정답 포인트 적립(PointService.earnQuiz)
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [QuizAttemptsController],
    providers: [QuizAttemptsService],
})
export class QuizAttemptsModule { }
