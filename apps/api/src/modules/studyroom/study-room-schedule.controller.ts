import { Body, Controller, Get, Header, Param, Patch, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ScheduleVisibilityDto } from './dto/schedule-visibility.dto.js';
import { StudyRoomScheduleService } from './study-room-schedule.service.js';

/**
 * 스터디룸 공용 일정(packages/shared PATHS.roomSchedule). 다른 스터디룸 경로와 파일을 나눠
 * study-rooms.controller를 고치는 PR들과 겹치지 않게 했다
 */
@Controller('study-rooms')
@UseGuards(JwtAuthGuard)
export class StudyRoomScheduleController {
  constructor(private readonly schedules: StudyRoomScheduleService) {}

  @Get(':id/schedule')
  @Header('Cache-Control', 'no-store')
  async schedule(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return { data: await this.schedules.schedule(id, requireUserId(req)) };
  }

  /** 이 방 시간표에서 내 수업 시간 숨기기 · 다시 보이기 */
  @Patch(':id/schedule/visibility')
  async visibility(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: ScheduleVisibilityDto,
  ) {
    return { data: await this.schedules.setScheduleHidden(id, requireUserId(req), body.hidden) };
  }
}
