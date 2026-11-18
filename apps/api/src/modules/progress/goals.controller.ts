import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import {
  IsDateString,
  Matches,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { SetWeeklyGoalDto } from './dto/set-weekly-goal.dto.js';
import { ProgressService, type WeeklyGoalView } from './progress.service.js';

@ValidatorConstraint({ name: 'isMondayWeekStart', async: false })
class IsMondayWeekStartConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      date.getUTCDay() === 1
    );
  }

  defaultMessage(): string {
    return 'weekStart는 유효한 월요일 날짜여야 합니다.';
  }
}

class AcknowledgeWeeklyGoalDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  @Validate(IsMondayWeekStartConstraint)
  weekStart!: string;
}

// 주소는 /api/v1/goals/... — 내 목표라 전부 로그인 필요
@Controller('goals')
@UseGuards(JwtAuthGuard)
export class GoalsController {
  constructor(private readonly progress: ProgressService) {}

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

  @Post('weekly/acknowledge')
  @HttpCode(204)
  async acknowledge(
    @Req() req: AuthenticatedRequest,
    @Body() body: AcknowledgeWeeklyGoalDto,
  ): Promise<void> {
    await this.progress.acknowledgeWeeklyGoal(requireUserId(req), body.weekStart);
  }
}
