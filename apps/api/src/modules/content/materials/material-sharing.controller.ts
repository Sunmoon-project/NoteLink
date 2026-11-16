import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { ShareMaterialsDto } from './dto/share-materials.dto.js';
import { MaterialSharingService } from './material-sharing.service.js';

/** 노트 공유 주소 (packages/shared PATHS.materialShare · roomShared) */
@Controller()
@UseGuards(JwtAuthGuard)
export class MaterialSharingController {
  constructor(private readonly sharing: MaterialSharingService) {}

  /** 내 노트를 스터디룸에 공유한다. 본문 없이 204 */
  @Post('materials/share')
  @HttpCode(204)
  async share(@Req() req: AuthenticatedRequest, @Body() body: ShareMaterialsDto): Promise<void> {
    await this.sharing.share(requireUserId(req), body);
  }
}
