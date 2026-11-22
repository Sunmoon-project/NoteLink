import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { AddClassDto, ShareTimetableDto } from './dto/timetable.dto.js';
import { TimetableService, type ClassView, type SharedTimetableView, type ShareView, type TimetableView } from './timetable.service.js';

// 주소는 /api/v1/timetable... — 내 시간표라 전부 로그인 필요
@Controller('timetable')
@UseGuards(JwtAuthGuard)
export class TimetableController {
    constructor(private readonly timetable: TimetableService) { }

    /** GET /api/v1/timetable */
    @Get()
    async get(@Req() req: AuthenticatedRequest): Promise<{ data: TimetableView }> {
        return { data: await this.timetable.get(requireUserId(req)) };
    }

    /** POST /api/v1/timetable/classes */
    @Post('classes')
    @HttpCode(HttpStatus.CREATED)
    async addClass(@Req() req: AuthenticatedRequest, @Body() body: AddClassDto): Promise<{ data: ClassView }> {
        return { data: await this.timetable.addClass(requireUserId(req), body) };
    }

    /** DELETE /api/v1/timetable/classes/:id */
    @Delete('classes/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async removeClass(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        await this.timetable.removeClass(requireUserId(req), id);
    }

    /** POST /api/v1/timetable/shares { friendIds, mode } */
    @Post('shares')
    @HttpCode(HttpStatus.NO_CONTENT)
    async share(@Req() req: AuthenticatedRequest, @Body() body: ShareTimetableDto): Promise<void> {
        await this.timetable.share(requireUserId(req), body);
    }

    /** GET /api/v1/timetable/shares */
    @Get('shares')
    async shares(@Req() req: AuthenticatedRequest): Promise<{ data: ShareView[] }> {
        return { data: await this.timetable.shares(requireUserId(req)) };
    }

    /** GET /api/v1/timetable/shared — 나에게 공유된 친구 시간표(공유받은 친구만, 빈 시간만이면 바쁜 시간만) */
    @Get('shared')
    async shared(@Req() req: AuthenticatedRequest): Promise<{ data: SharedTimetableView[] }> {
        return { data: await this.timetable.sharedWithMe(requireUserId(req)) };
    }
}
