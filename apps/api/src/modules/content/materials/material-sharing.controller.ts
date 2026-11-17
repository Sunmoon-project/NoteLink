import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { RoomSharedItem } from '@notelink/shared';

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

  /**
   * 방에 공유된 자료. 현재 멤버만(아니면 404). 경로는 study-rooms 아래지만 스터디룸 컨트롤러가 아니라 노트 쪽에 둔다.
   * 스터디룸 컨트롤러의 `study-rooms/:id` 는 한 구간만 맞아서 이 주소와 겹치지 않는다
   */
  @Get('study-rooms/:id/shared-items')
  async roomItems(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: { items: RoomSharedItem[]; flashcards: never[] } }> {
    return { data: await this.sharing.listRoomItems(requireUserId(req), id) };
  }
}
