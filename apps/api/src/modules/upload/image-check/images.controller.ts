import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { CheckImagesDto } from './check-images.dto.js';
import { ImageCheckService, type ImageVerdict } from './image-check.service.js';

/** 필기 사진 검사 주소 (packages/shared PATHS.imageCheck) */
@Controller('images')
@UseGuards(JwtAuthGuard)
export class ImagesController {
  constructor(private readonly images: ImageCheckService) {}

  /** 올린 사진마다 판정. 보낸 순서 그대로 { name, verdict } */
  @Post('check')
  @HttpCode(HttpStatus.OK)
  async check(
    @Req() req: AuthenticatedRequest,
    @Body() body: CheckImagesDto,
  ): Promise<{ data: { name: string; verdict: ImageVerdict }[] }> {
    return { data: await this.images.check(requireUserId(req), body.files) };
  }
}
