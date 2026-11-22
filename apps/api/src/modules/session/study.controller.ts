import {
    Body,
    ConflictException,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';
import { ERROR_CODES } from '@notelink/shared';

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

    /**
     * DELETE /api/v1/study/items/:id — 목록에서만 숨기고 기록(쌓인 시간 · 통계)은 남긴다(HOME-002).
     * 남의 항목 · 없는 항목은 404, 이미 지운 항목은 다시 불러도 204, 측정 중(일시정지 포함)인 항목은 409
     */
    @Delete('items/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async removeItem(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        const result = await this.study.removeItem(requireUserId(req), id);
        if (result === 'not_found') {
            throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: '존재하지 않는 공부 항목입니다.' });
        }
        if (result === 'in_session') {
            throw new ConflictException({
                code: ERROR_CODES.STUDY_ITEM_IN_SESSION,
                message: '측정 중인 공부 항목은 공부를 끝낸 뒤 지울 수 있습니다.',
            });
        }
    }
}
