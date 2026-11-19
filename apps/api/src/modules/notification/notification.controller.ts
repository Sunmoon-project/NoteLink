import {
  Controller,
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

  /** PATCH /notifications/:id/read → 204. 내 알림이 아니면 404 */
  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.notifications.markRead(requireUserId(req), id);
  }
}
