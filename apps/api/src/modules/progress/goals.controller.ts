import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { SetWeeklyGoalDto } from './dto/set-weekly-goal.dto.js';
import { ProgressService, type WeeklyGoalView } from './progress.service.js';

// 주소는 /api/v1/goals/... — 내 목표라 전부 로그인 필요
@Controller('goals')
@UseGuards(JwtAuthGuard)
export class GoalsController {
    constructor(private readonly progress: ProgressService) { }

    /** GET /api/v1/goals/weekly */
    @Get('weekly')
    async getWeekly(@Req() req: AuthenticatedRequest): Promise<{ data: WeeklyGoalView }> {
        return { data: await this.progress.getWeeklyGoal(requireUserId(req)) };
    }

    /** PUT /api/v1/goals/weekly { targetMin, notify80 } */
    @Put('weekly')
    async setWeekly(
        @Req() req: AuthenticatedRequest,
        @Body() body: SetWeeklyGoalDto,
    ): Promise<{ data: WeeklyGoalView }> {
        return { data: await this.progress.setWeeklyGoal(requireUserId(req), body) };
    }
}
