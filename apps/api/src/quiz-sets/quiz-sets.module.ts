import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from '../ai-jobs/ai-jobs.module.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { Material, MaterialSchema } from '../modules/content/schemas/material.schema.js';
import { QuizAttempt, QuizAttemptSchema } from '../modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, QuizSetSchema } from '../modules/quiz/schemas/quiz-set.schema.js';
import { QuizSetsController } from './quiz-sets.controller.js';
import { QuizSetsService } from './quiz-sets.service.js';

/**
 * 맞춤 퀴즈 세트 만들기 · 조회(#175). 문제는 AI 작업(ai-jobs)으로 만들고, 노트(materials)와
 * 풀이 기록(quiz_attempts)은 처리기 입력을 만들 때 읽기만 한다.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: QuizSet.name, schema: QuizSetSchema },
      { name: Material.name, schema: MaterialSchema },
      { name: QuizAttempt.name, schema: QuizAttemptSchema },
    ]),
    AiJobsModule,
    // JwtAuthGuard · TokenService
    AuthModule,
  ],
  controllers: [QuizSetsController],
  providers: [QuizSetsService],
})
export class QuizSetsModule {}
