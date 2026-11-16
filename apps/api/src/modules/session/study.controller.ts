import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { requireUserId } from '../../common/request-user.js';
import { CreateStudyItemDto } from './dto/create-study-item.dto.js';
import { StudyService, type DailyRecordView, type StudyItemView } from './study.service.js';

// 주소는 /api/v1/study/... — 내 기록이라 전부 로그인 필요
@Controller('study')
@UseGuards(JwtAuthGuard)
export class StudyController {
    constructor(private readonly study: StudyService) { }

    /** GET /api/v1/study/today */
    @Get('today')
    async today(@Req() req: AuthenticatedRequest): Promise<{ data: DailyRecordView }> {
        return { data: await this.study.today(requireUserId(req)) };
    }

    /** POST /api/v1/study/items { title, subjectName, goalMin } */
    @Post('items')
    async addItem(
        @Req() req: AuthenticatedRequest,
        @Body() body: CreateStudyItemDto,
    ): Promise<{ data: StudyItemView }> {
        return { data: await this.study.addItem(requireUserId(req), body) };
    }
}
