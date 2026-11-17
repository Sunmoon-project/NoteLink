import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AppAiJob } from '../../../ai-jobs/ai-jobs.service.js';
import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { NoteAskService } from './note-ask.service.js';

/** POST /api/v1/materials/:id/ask (packages/shared PATHS.materialAsk) */
@Controller('materials')
@UseGuards(JwtAuthGuard)
export class NoteAskController {
  constructor(private readonly notes: NoteAskService) {}

  @Post(':id/ask')
  @HttpCode(HttpStatus.ACCEPTED)
  async ask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ data: AppAiJob }> {
    return { data: await this.notes.ask(requireUserId(req), id, body) };
  }
}
