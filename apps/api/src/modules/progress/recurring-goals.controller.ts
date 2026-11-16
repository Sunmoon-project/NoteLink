import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { SaveRecurringGoalDto } from './dto/recurring-goal.dto.js';
import { RecurringGoalsService, type RecurringGoalView } from './recurring-goals.service.js';

// 주소는 /api/v1/goals/recurring — 내 목표라 전부 로그인 필요
@Controller('goals/recurring')
@UseGuards(JwtAuthGuard)
export class RecurringGoalsController {
    constructor(private readonly goals: RecurringGoalsService) { }

    /** GET /api/v1/goals/recurring */
    @Get()
    async list(@Req() req: AuthenticatedRequest): Promise<{ data: RecurringGoalView[] }> {
        return { data: await this.goals.list(requireUserId(req)) };
    }

    /** POST /api/v1/goals/recurring { name, days, targetMin?, ... } */
    @Post()
    @HttpCode(HttpStatus.CREATED)
    async create(@Req() req: AuthenticatedRequest, @Body() body: SaveRecurringGoalDto): Promise<{ data: RecurringGoalView }> {
        return { data: await this.goals.create(requireUserId(req), body) };
    }

    /** PATCH /api/v1/goals/recurring/:id — 보낸 필드만 바꾼다 */
    @Patch(':id')
    async update(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: SaveRecurringGoalDto,
    ): Promise<{ data: RecurringGoalView }> {
        return { data: await this.goals.update(requireUserId(req), id, body) };
    }

    /** DELETE /api/v1/goals/recurring/:id — 목록에서만 빠지고 DB에는 남는다 */
    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        await this.goals.remove(requireUserId(req), id);
    }
}
