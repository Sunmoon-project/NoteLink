import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Recording } from '@notelink/shared';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { RecordingService } from './recording.service.js';

/** 녹음 재생 정보 주소 (packages/shared PATHS.materialRecording) */
@Controller()
@UseGuards(JwtAuthGuard)
export class RecordingController {
  constructor(private readonly recordings: RecordingService) {}

  /** 원본 녹음 읽기 주소(1시간) + 정리가 끝났으면 대본 · 슬라이드 */
  @Get('materials/:id/recording')
  async findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: Recording }> {
    return { data: await this.recordings.findMine(requireUserId(req), id) };
  }
}
