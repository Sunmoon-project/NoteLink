import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { RemoveNotificationsDto } from './dto/remove-notifications.dto.js';
import { NotificationService } from './notification.service.js';

/** 앱 안 알림함. 주소는 /api/v1/notifications... (packages/shared PATHS), 모두 로그인 필요 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  /** GET /notifications?before=&limit= → { data: { items: 알림[], nextCursor } } (최근 것부터, 최대 50) */
  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    const { items, nextCursor } = await this.notifications.list(requireUserId(req), {
      before: typeof before === 'string' ? before : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return { data: { items, nextCursor } };
  }

  /** GET /notifications/unread-count → { data: { count } } */
  @Get('unread-count')
  async unreadCount(@Req() req: AuthenticatedRequest) {
    return { data: { count: await this.notifications.unreadCount(requireUserId(req)) } };
  }

  /** POST /notifications/read-all → 204 */
  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async readAll(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.notifications.markAllRead(requireUserId(req));
  }

  /** DELETE /notifications → 204. 내 알림함을 모두 비운다(전체 선택 삭제: 아직 불러오지 않은 쪽까지) */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAll(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.notifications.removeAll(requireUserId(req));
  }

  /** POST /notifications/delete { ids } → 204. 고른 알림 중 내 것만 지운다(이미 지운 · 남의 알림은 건너뜀) */
  @Post('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMany(
    @Req() req: AuthenticatedRequest,
    @Body() body: RemoveNotificationsDto,
  ): Promise<void> {
    await this.notifications.removeMany(requireUserId(req), body.ids);
  }

  /** PATCH /notifications/:id/read → 204. 내 알림이 아니면 404 */
  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.notifications.markRead(requireUserId(req), id);
  }

  /** DELETE /notifications/:id → 204. 알림함에서 지운다. 내 알림이 아니면 404 */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.notifications.remove(requireUserId(req), id);
  }
}
