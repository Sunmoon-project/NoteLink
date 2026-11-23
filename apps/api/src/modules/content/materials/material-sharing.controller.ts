import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Flashcard, FriendShare, QuizSet, RoomSharedItem } from '@notelink/shared';

import { Types } from 'mongoose';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { CopyFriendShareDto, ShareMaterialsDto } from './dto/share-materials.dto.js';
import { ShareStudyItemDto } from './dto/share-study-item.dto.js';
import { FriendShareService, notFound } from './friend-share.service.js';
import { MaterialSharingService } from './material-sharing.service.js';

/** 노트 공유 주소 (packages/shared PATHS.materialShare · roomShared) */
@Controller()
@UseGuards(JwtAuthGuard)
export class MaterialSharingController {
  constructor(
    private readonly sharing: MaterialSharingService,
    private readonly friendShares: FriendShareService,
  ) {}

  /** 내 노트를 스터디룸(target.id) 또는 친구들(target.ids, #554)에게 공유한다. 본문 없이 204 */
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

  /** 내 퀴즈 하나 또는 고른 플래시카드들을 방에 공유한다(#481). 본문 없이 204 */
  @Post('study-rooms/:id/shared-items')
  @HttpCode(204)
  async shareStudyItem(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ShareStudyItemDto,
  ): Promise<void> {
    await this.sharing.shareStudyItem(requireUserId(req), id, body);
  }

  /** 방에 공유된 퀴즈(문제 · 정답) · 플래시카드 묶음을 연다. 현재 멤버만(아니면 404) */
  @Get('study-rooms/:id/shared-items/:itemId')
  async openRoomItem(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ): Promise<{ data: { item: RoomSharedItem; quiz: QuizSet | null; flashcards: Flashcard[] } }> {
    return { data: await this.sharing.openRoomItem(requireUserId(req), id, itemId) };
  }

  /** 친구에게 보낸 노트 하나(1:1 채팅 공유 카드를 열 때). 보낸 사람 · 받은 사람만(아니면 404) */
  @Get('friend-shares/:id')
  async openFriendShare(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: FriendShare }> {
    return { data: await this.friendShares.open(requireUserId(req), id) };
  }

  /** 보낸 사람이 친구 공유를 끝낸다. 본문 없이 204 */
  @Delete('friend-shares/:id')
  @HttpCode(204)
  async revokeFriendShare(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.friendShares.revoke(requireUserId(req), id);
  }

  /** 받은 노트를 내 노트로 복사한다 → 새 노트 id · 넣은 폴더 */
  @Post('friend-shares/:id/copy')
  async copyFriendShare(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: CopyFriendShareDto,
  ): Promise<{ data: { _id: string; folderId: string } }> {
    return { data: await this.friendShares.copy(requireUserId(req), id, body.folderId) };
  }

  /**
   * 방 · 친구에게 공유받은 남의 노트를 고른 내 폴더(없으면 최근 폴더)로 가져온다 → 새 노트 id · 넣은 폴더.
   * 볼 수 없는 노트 · 내 노트는 404(내 노트는 가져올 일이 없다)
   */
  @Post('materials/:id/copy')
  async copyShared(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: CopyFriendShareDto,
  ): Promise<{ data: { _id: string; folderId: string } }> {
    const userId = requireUserId(req);
    const ownerId = await this.sharing.ownerOfShared(userId, id);
    if (!ownerId || ownerId === userId) throw notFound('노트');
    return {
      data: await this.friendShares.copyNote(
        userId,
        new Types.ObjectId(ownerId),
        new Types.ObjectId(id),
        body.folderId,
      ),
    };
  }
}
