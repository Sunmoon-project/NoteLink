import { Controller, Get, Header, Param, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
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
}
