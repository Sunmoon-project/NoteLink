import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ProgressService, type WeeklySummaryView } from './progress.service.js';

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
}
