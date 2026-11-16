import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ERROR_CODES, type Friend, type FriendRequest } from '@notelink/shared';

import { requireUserId } from '../../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../../auth/jwt-auth.guard.js';
import { FriendsService } from './friends.service.js';

const NICKNAME_MAX = 30;

/** 친구 찾기 · 요청 · 목록 · 삭제(FR-15). 주소는 /api/v1/... (packages/shared PATHS), 모두 로그인 필요 */
@Controller()
@UseGuards(JwtAuthGuard)
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  /** GET /users/search?nickname= — 닉네임이 같은 사람(나 · 탈퇴한 사람 제외) */
  @Get('users/search')
  async search(
    @Req() req: AuthenticatedRequest,
    @Query('nickname') nickname: unknown,
  ): Promise<{ data: Friend[] }> {
    if (typeof nickname !== 'string' || nickname.length > NICKNAME_MAX) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '닉네임을 확인해 주세요',
      });
    }
    return { data: await this.friends.search(requireUserId(req), nickname) };
  }

  /** POST /friend-requests { userId } → 204 */
  @Post('friend-requests')
  @HttpCode(HttpStatus.NO_CONTENT)
  async request(@Req() req: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const userId = (body as { userId?: unknown } | null)?.userId;
    if (typeof userId !== 'string') {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: 'userId가 필요합니다',
      });
    }
    await this.friends.request(requireUserId(req), userId);
  }

  /** GET /friend-requests/received — 나에게 온 대기 중 요청 */
  @Get('friend-requests/received')
  async received(@Req() req: AuthenticatedRequest): Promise<{ data: FriendRequest[] }> {
    return { data: await this.friends.received(requireUserId(req)) };
  }

  /** POST /friend-requests/:id/accept → 204 */
  @Post('friend-requests/:id/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  async accept(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.friends.respond(requireUserId(req), id, true);
  }

  /** POST /friend-requests/:id/reject → 204 */
  @Post('friend-requests/:id/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.friends.respond(requireUserId(req), id, false);
  }

  /** GET /friends — 내 친구 목록 */
  @Get('friends')
  async list(@Req() req: AuthenticatedRequest): Promise<{ data: Friend[] }> {
    return { data: await this.friends.friends(requireUserId(req)) };
  }

  /** DELETE /friends/:userId → 204. 서로의 시간표 공유도 정리한다 */
  @Delete('friends/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthenticatedRequest, @Param('userId') userId: string): Promise<void> {
    await this.friends.remove(requireUserId(req), userId);
  }
}
