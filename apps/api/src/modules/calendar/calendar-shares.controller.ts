import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { CalendarSharesService, type CalendarShareView } from './calendar-shares.service.js';
import { CreateCalendarShareDto } from './dto/calendar-share.dto.js';

// 주소는 /api/v1/calendar-shares... — 링크를 만들고 받는 것 모두 로그인 필요
@Controller('calendar-shares')
@UseGuards(JwtAuthGuard)
export class CalendarSharesController {
    constructor(private readonly shares: CalendarSharesService) { }

    /** GET /api/v1/calendar-shares — 내가 만든 링크 */
    @Get()
    async list(@Req() req: AuthenticatedRequest): Promise<{ data: CalendarShareView[] }> {
        return { data: await this.shares.list(requireUserId(req)) };
    }

    // 'received'를 ':id' 주소보다 먼저 둔다

    /** GET /api/v1/calendar-shares/received — 내가 받은 캘린더 */
    @Get('received')
    async received(@Req() req: AuthenticatedRequest): Promise<{ data: Awaited<ReturnType<CalendarSharesService['received']>> }> {
        return { data: await this.shares.received(requireUserId(req)) };
    }

    /** POST /api/v1/calendar-shares { rangeStart, rangeEnd, expiresInDays, scopes? } */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    async create(@Req() req: AuthenticatedRequest, @Body() body: CreateCalendarShareDto): Promise<{ data: CalendarShareView & { url: string } }> {
        return { data: await this.shares.create(requireUserId(req), body) };
    }

    /** POST /api/v1/calendar-shares/:id/subscribe — :id 자리에는 공유 id 또는 링크의 토큰 */
    @Post(':id/subscribe')
    @HttpCode(HttpStatus.NO_CONTENT)
    async subscribe(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        await this.shares.subscribe(requireUserId(req), id);
    }

    /** DELETE /api/v1/calendar-shares/:id — 링크 취소 */
    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async revoke(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        await this.shares.revoke(requireUserId(req), id);
    }
}
