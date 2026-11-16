import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { StartAttemptDto, SubmitAnswerDto } from './dto/quiz-attempt.dto.js';
import { QuizAttemptsService, type AnswerResult, type AppQuizAttempt, type FinishResult } from './quiz-attempts.service.js';

// 주소는 /api/v1/quiz-attempts... (packages/shared PATHS.quizAttempts · attemptAnswer · attemptFinish). 내 풀이라 로그인 필요
@Controller('quiz-attempts')
@UseGuards(JwtAuthGuard)
export class QuizAttemptsController {
    constructor(private readonly attempts: QuizAttemptsService) { }

    /** POST /api/v1/quiz-attempts { quizSetId } → 201 { data: QuizAttempt } */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    async start(@Req() req: AuthenticatedRequest, @Body() body: StartAttemptDto): Promise<{ data: AppQuizAttempt }> {
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
        return { data: await this.attempts.answer(requireUserId(req), id, body.questionId, body.answer) };
    }

    /** POST /api/v1/quiz-attempts/:id/finish → 200 { data: { pointsEarned, balance } } */
    @Post(':id/finish')
    @HttpCode(HttpStatus.OK)
    async finish(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ data: FinishResult }> {
        return { data: await this.attempts.finish(requireUserId(req), id) };
    }
}
