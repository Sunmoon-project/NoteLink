import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../../auth/jwt-auth.guard.js';
import { ListPointLedgerDto } from '../dto/list-point-ledger.dto.js';
import { PointService, type PointLedgerView } from './point.service.js';
import { requireUserId } from '../../../common/request-user.js';

// 주소는 /api/v1/points/ledger — 내 내역이라 로그인 필요
@Controller('points/ledger')
@UseGuards(JwtAuthGuard)
export class PointController {
    constructor(private readonly points: PointService) { }

    /** GET /api/v1/points/ledger?type=earn|spend&limit&cursor */
    @Get()
    async list(
        @Req() req: AuthenticatedRequest,
        @Query() query: ListPointLedgerDto,
    ): Promise<{ data: PointLedgerView[] }> {
        return { data: await this.points.listLedger(requireUserId(req), query) };
    }
}