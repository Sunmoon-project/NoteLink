import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { CreateCustomHolidayDto, HideHolidayDto, HolidayDateParamDto, HolidaysQueryDto } from './dto/holiday.dto.js';
import { HolidaysService, type CustomHolidayView, type PublicHolidayView } from './holidays.service.js';

// 주소는 /api/v1/holidays... — 숨김 · 제외일이 내 것이라 전부 로그인 필요
@Controller('holidays')
@UseGuards(JwtAuthGuard)
export class HolidaysController {
    constructor(private readonly holidays: HolidaysService) { }

    /** GET /api/v1/holidays?year=2026 */
    @Get()
    async list(@Req() req: AuthenticatedRequest, @Query() query: HolidaysQueryDto): Promise<{ data: PublicHolidayView[] }> {
        return { data: await this.holidays.list(requireUserId(req), query.year) };
    }

    // 'custom' 주소를 ':date'보다 먼저 둔다 (안 그러면 날짜 자리에 'custom'이 들어간다)

    /** GET /api/v1/holidays/custom */
    @Get('custom')
    async customList(@Req() req: AuthenticatedRequest): Promise<{ data: CustomHolidayView[] }> {
        return { data: await this.holidays.customList(requireUserId(req)) };
    }

    /** POST /api/v1/holidays/custom { name, date } */
    @Post('custom')
    @HttpCode(HttpStatus.CREATED)
    async customAdd(@Req() req: AuthenticatedRequest, @Body() body: CreateCustomHolidayDto): Promise<{ data: CustomHolidayView }> {
        return { data: await this.holidays.customAdd(requireUserId(req), body) };
    }

    /** DELETE /api/v1/holidays/custom/:id */
    @Delete('custom/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async customRemove(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
        await this.holidays.customRemove(requireUserId(req), id);
    }

    /** PATCH /api/v1/holidays/:date { hidden } */
    @Patch(':date')
    @HttpCode(HttpStatus.NO_CONTENT)
    async setHidden(@Req() req: AuthenticatedRequest, @Param() params: HolidayDateParamDto, @Body() body: HideHolidayDto): Promise<void> {
        await this.holidays.setHidden(requireUserId(req), params.date, body.hidden);
    }
}
