import {
    Body,
    Controller,
    HttpCode,
    NotFoundException,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { requireUserId } from '../../common/request-user.js';
import { EndStudySessionDto } from './dto/end-study-session.dto.js';
import { StartStudySessionDto } from './dto/start-study-session.dto.js';
import { StudyService, type EndResult, type StudySessionView } from './study.service.js';

// 주소는 /api/v1/study-sessions/... — 공부 시간은 "누구 것"인지 알아야 해서 전부 로그인 필요
@Controller('study-sessions')
@UseGuards(JwtAuthGuard)
export class StudySessionsController {
    constructor(private readonly study: StudyService) { }

    /** POST /api/v1/study-sessions { studyItemId, mode } */
    @Post()
    async start(
        @Req() req: AuthenticatedRequest,
        @Body() body: StartStudySessionDto,
    ): Promise<{ data: StudySessionView }> {
        const session = await this.study.startSession(requireUserId(req), body);
        if (!session) {
            throw new NotFoundException({ code: 'NOT_FOUND', message: '존재하지 않는 공부 항목입니다.' });
        }
        return { data: session };
    }

    /** POST /api/v1/study-sessions/:id/pause */
    @Post(':id/pause')
    @HttpCode(204)
    async pause(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        if (!(await this.study.pause(requireUserId(req), id))) throw sessionNotFound();
    }

    /** POST /api/v1/study-sessions/:id/resume */
    @Post(':id/resume')
    @HttpCode(204)
    async resume(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        if (!(await this.study.resume(requireUserId(req), id))) throw sessionNotFound();
    }

    /** POST /api/v1/study-sessions/:id/end { clientDurationSec, endReason } */
    @Post(':id/end')
    @HttpCode(200)
    async end(
        @Req() req: AuthenticatedRequest,
        @Param('id') id: string,
        @Body() body: EndStudySessionDto,
    ): Promise<{ data: EndResult }> {
        const result = await this.study.end(requireUserId(req), id, body);
        if (!result) throw sessionNotFound();
        return { data: result };
    }
}

function sessionNotFound(): NotFoundException {
    return new NotFoundException({ code: 'NOT_FOUND', message: '존재하지 않는 세션입니다.' });
}
