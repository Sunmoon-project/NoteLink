import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AppAiJob } from '../ai-jobs/ai-jobs.service.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../modules/auth/jwt-auth.guard.js';
import { type AppQuizSet, QuizSetsService, VALIDATION_FAILED } from './quiz-sets.service.js';

/** 가드를 통과한 요청에는 항상 user가 붙는다(JwtAuthGuard) */
const userOf = (req: AuthenticatedRequest): string => req.user!.userId;

/** POST 본문 `{ materialId }`. 문자열이 아니면 400 */
export function readMaterialId(body: unknown): string {
  const value = (body as { materialId?: unknown } | null | undefined)?.materialId;
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException({ code: VALIDATION_FAILED, message: 'materialId가 필요해요' });
  }
  return value;
}

/**
 * 맞춤 퀴즈 세트(#175). 전역 접두사가 붙어 `/api/v1/quiz-sets`가 된다(packages/shared PATHS.quizSets · quizSet).
 * 응답 모양은 앱의 로컬 모의 API(apps/mobile/src/lib/local/api.ts `quiz.sets` · `createSet` · `set`)와 같다.
 */
@Controller('quiz-sets')
@UseGuards(JwtAuthGuard)
export class QuizSetsController {
  constructor(private readonly quizSets: QuizSetsService) {}

  /** 노트로 맞춤 퀴즈를 만든다. 진행 상태는 받은 job으로 `/ai-jobs/:id`에서 본다 */
  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ data: { quizSet: AppQuizSet; job: AppAiJob } }> {
    return { data: await this.quizSets.create(userOf(req), readMaterialId(body)) };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AuthenticatedRequest): Promise<{ data: AppQuizSet[] }> {
    return { data: await this.quizSets.list(userOf(req)) };
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: AppQuizSet }> {
    return { data: await this.quizSets.findMine(userOf(req), id) };
  }
}
