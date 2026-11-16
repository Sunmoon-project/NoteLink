import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { ImagesService } from './images.service.js';

/** POST /api/v1/images/check — Blob 업로드가 끝난 사진의 필기 여부 · 선명도를 확인한다. */
@Controller('images')
@UseGuards(JwtAuthGuard)
export class ImagesController {
  constructor(private readonly images: ImagesService) {}

  @Post('check')
  async check(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return { data: await this.images.check(requireUserId(req), body) };
  }
}
