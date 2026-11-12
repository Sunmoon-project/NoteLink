import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { MonthQueryDto, StatsQueryDto } from './dto/study-query.dto.js';
import { ProgressService, type MonthDayView, type StudyStatsView, type WeeklySummaryView } from './progress.service.js';

// 주소는 /api/v1/study/... (오늘 기록은 session 모듈, 통계는 여기)
@Controller('study')
@UseGuards(JwtAuthGuard)
export class StudyProgressController {
    constructor(private readonly progress: ProgressService) { }

    /** GET /api/v1/study/weekly */
    @Get('weekly')
    async weekly(@Req() req: AuthenticatedRequest): Promise<{ data: WeeklySummaryView }> {
        return { data: await this.progress.weekly(requireUserId(req)) };
    }

    /** GET /api/v1/study/month?ym=2026-11 */
    @Get('month')
    async month(@Req() req: AuthenticatedRequest, @Query() query: MonthQueryDto): Promise<{ data: MonthDayView[] }> {
        return { data: await this.progress.month(requireUserId(req), query.ym) };
    }

    /** GET /api/v1/study/stats?range=all|90d|30d */
    @Get('stats')
    async stats(@Req() req: AuthenticatedRequest, @Query() query: StatsQueryDto): Promise<{ data: StudyStatsView }> {
        return { data: await this.progress.stats(requireUserId(req), query.range) };
    }
}
