import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { type AuthenticatedRequest, JwtAuthGuard } from '../modules/auth/jwt-auth.guard.js';
import { type AppAiJob, AiJobsService } from './ai-jobs.service.js';

/** 가드를 통과한 요청에는 항상 user가 붙는다(JwtAuthGuard) */
const userOf = (req: AuthenticatedRequest): string => req.user!.userId;

/**
 * 앱의 AI 작업 진행 상태 · 취소 · 다시 시도(#175). 전역 접두사가 붙어 `/api/v1/ai-jobs/...`가 된다
 * (packages/shared PATHS.aiJob · aiJobCancel · aiJobRetry). 응답 모양은 앱의 로컬 모의 API
 * (apps/mobile/src/lib/local/api.ts `ai`)와 같다. 본인 작업만 다루고, 남의 작업은 없는 작업과 같게 404.
 */
@Controller('ai-jobs')
@UseGuards(JwtAuthGuard)
export class AiJobsController {
  constructor(private readonly jobs: AiJobsService) {}

  /** 진행 상태. 앱은 몇 초마다 다시 부르므로 저장해 두지 않게 한다 */
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: AppAiJob }> {
    return { data: await this.jobs.findMine(userOf(req), id) };
  }

  /** 아직 끝나지 않았으면 취소한다. 이미 끝난 작업이어도 같은 204(앱이 두 번 눌러도 같음) */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.jobs.cancel(userOf(req), id);
  }

  /** 실패 · 취소한 작업을 다시 넣는다. 다시 넣지 않은 경우(처리 중 · 성공)도 지금 상태를 돌려준다 */
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  async retry(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: AppAiJob }> {
    return { data: await this.jobs.retry(userOf(req), id) };
  }
}
