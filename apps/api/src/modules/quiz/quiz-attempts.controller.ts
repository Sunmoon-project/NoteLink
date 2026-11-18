import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { SimilarQuizService } from '../../quiz-sets/similar-quiz.service.js';
import { StartAttemptDto, SubmitAnswerDto } from './dto/quiz-attempt.dto.js';
import {
  QuizAttemptsService,
  type AnswerResult,
  type AppQuizAttempt,
  type FinishResult,
} from './quiz-attempts.service.js';

// 주소는 /api/v1/quiz-attempts... (packages/shared PATHS.quizAttempts · attemptAnswer · attemptFinish). 내 풀이라 로그인 필요
@Controller('quiz-attempts')
@UseGuards(JwtAuthGuard)
export class QuizAttemptsController {
  private readonly logger = new Logger('QuizAttempts');

  constructor(
    private readonly attempts: QuizAttemptsService,
    private readonly review: SimilarQuizService,
  ) {}

  /** POST /api/v1/quiz-attempts { quizSetId } → 201 { data: QuizAttempt } */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async start(
    @Req() req: AuthenticatedRequest,
    @Body() body: StartAttemptDto,
  ): Promise<{ data: AppQuizAttempt }> {
    return { data: await this.attempts.start(requireUserId(req), body.quizSetId) };
  }

  /** POST /api/v1/quiz-attempts/:id/answers { questionId, answer } → 200 { data: { correct, correctAnswer } } */
  @Post(':id/answers')
  @HttpCode(HttpStatus.OK)
  async answer(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: SubmitAnswerDto,
  ): Promise<{ data: AnswerResult }> {
    return {
      data: await this.attempts.answer(requireUserId(req), id, body.questionId, body.answer),
    };
  }

  /** POST /api/v1/quiz-attempts/:id/finish → 200 { data: { pointsEarned, balance } } */
  @Post(':id/finish')
  @HttpCode(HttpStatus.OK)
  async finish(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: FinishResult }> {
    const userId = requireUserId(req);
    const data = await this.attempts.finish(userId, id);
    // 틀린 문제가 있으면 오답 복습(유사 퀴즈 · 복습 일정)을 바로 시작한다. 실패해도 끝내기 응답 · 포인트는 그대로
    await this.review.startAfterFinish(userId, id).catch((e: unknown) => {
      this.logger.warn(`오답 복습을 시작하지 못했습니다(끝내기는 그대로): ${String(e)}`);
    });
    return { data };
  }
}
