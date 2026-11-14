import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import type { AppQuestion } from '../../quiz-sets/quiz-sets.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { QuestionIdsDto } from './dto/quiz-box.dto.js';
import { QuizBoxService } from './quiz-box.service.js';

// 주소는 /api/v1/quiz-box... (packages/shared PATHS.quizBox). 내 보관함이라 로그인 필요
@Controller('quiz-box')
@UseGuards(JwtAuthGuard)
export class QuizBoxController {
    constructor(private readonly box: QuizBoxService) { }

    /** GET /api/v1/quiz-box → 200 { data: Question[] } (담은 순서, 정답 포함) */
    @Get()
    async list(@Req() req: AuthenticatedRequest): Promise<{ data: AppQuestion[] }> {
        return { data: await this.box.box(requireUserId(req)) };
    }

    /** POST /api/v1/quiz-box { questionIds } → 200 { data: Question[] } (담은 뒤 보관함 전체) */
    @Post()
    @HttpCode(HttpStatus.OK)
    async save(@Req() req: AuthenticatedRequest, @Body() body: QuestionIdsDto): Promise<{ data: AppQuestion[] }> {
        return { data: await this.box.save(requireUserId(req), body.questionIds) };
    }

    /** POST /api/v1/quiz-box/delete { questionIds } → 204 */
    @Post('delete')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Req() req: AuthenticatedRequest, @Body() body: QuestionIdsDto): Promise<void> {
        await this.box.remove(requireUserId(req), body.questionIds);
    }
}
