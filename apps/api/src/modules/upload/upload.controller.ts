import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { UploadTarget } from '@notelink/shared';

import { requireUserId } from '../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UploadService } from './upload.service.js';

/** POST /api/v1/uploads/sas (packages/shared PATHS.uploadSas) */
@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  @Post('sas')
  @HttpCode(HttpStatus.OK)
  async sas(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ data: UploadTarget }> {
    return { data: await this.uploads.createTarget(requireUserId(req), body) };
  }
}
