import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from '../ai-jobs/ai-jobs.module.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { Folder, FolderSchema } from '../modules/content/schemas/folder.schema.js';
import { Material, MaterialSchema } from '../modules/content/schemas/material.schema.js';
import { AiJob, AiJobSchema } from '../modules/quiz/schemas/ai-job.schema.js';
import { Flashcard, FlashcardSchema } from '../modules/quiz/schemas/flashcard.schema.js';
import { QuizAttempt, QuizAttemptSchema } from '../modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizBoxItem, QuizBoxItemSchema } from '../modules/quiz/schemas/quiz-box-item.schema.js';
import { QuizSet, QuizSetSchema } from '../modules/quiz/schemas/quiz-set.schema.js';
import { QuizCleanupService } from './quiz-cleanup.service.js';
import { QuizSetsController } from './quiz-sets.controller.js';
import { QuizSetsService } from './quiz-sets.service.js';
import { RecordingNotePagesService } from './recording-note-pages.service.js';
import { SimilarQuizService } from './similar-quiz.service.js';
import { TodayReviewService } from './today-review.service.js';
import { ExplanationsController, ExplanationsService } from './explanations.controller.js';

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
      { name: AiJob.name, schema: AiJobSchema }, // 녹음 노트의 대본(녹음 정리 작업 결과)을 읽는다
      // 학습 폴더를 지울 때 그 폴더의 카드 · 보관함 항목을 같이 지운다(QuizCleanupService, #602)
      { name: Flashcard.name, schema: FlashcardSchema },
      { name: QuizBoxItem.name, schema: QuizBoxItemSchema },
      // 세트를 넣은 뒤 노트의 학습 폴더가 지워졌는지 읽기만 한다(QuizSetsService.folderGone)
      { name: Folder.name, schema: FolderSchema },
    ]),
    AiJobsModule,
    // JwtAuthGuard · TokenService
    AuthModule,
  ],
  controllers: [QuizSetsController, ExplanationsController],
  providers: [
    QuizSetsService,
    SimilarQuizService,
    ExplanationsService,
    RecordingNotePagesService,
    TodayReviewService,
    QuizCleanupService,
  ],
  // 노트 API 가 정리를 마친 노트의 첫 퀴즈를 미리 만든다(pregenerate)
  // 퀴즈를 끝내면 오답 복습을 시작한다(QuizAttemptsController)
  // 학습 폴더 삭제가 그 폴더의 퀴즈 · 카드 · 보관함 항목을 같이 지운다(QuizCleanupService, #602)
  exports: [QuizSetsService, SimilarQuizService, QuizCleanupService],
})
export class QuizSetsModule {}
