import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { Roles } from '../../common/roles.decorator.js';
import { ROLES } from '../../common/roles.js';
import { RolesGuard } from '../../common/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { CreateReportDto } from './dto/create-report.dto.js';
import { UpdateReportStatusDto } from './dto/update-report-status.dto.js';
import { ReportDetailView, ReportView, SocialService } from './social.service.js';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard) // 로그인 + (지정 시) 역할 검사
export class SocialController {
  constructor(private readonly socialService: SocialService) {}

  // POST /api/v1/reports — 신고 접수 (로그인한 사용자 누구나, 발표자료 p.78)
  @Post('reports')
  @HttpCode(HttpStatus.CREATED)
  async createReport(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateReportDto,
  ): Promise<{ data: ReportView }> {
    const data = await this.socialService.createReport(req.user.userId, dto);
    return { data };
  }

  // GET /api/v1/reports — 신고 목록 조회 (관리자 전용)
  @Get('reports')
  @Roles(ROLES.ADMIN)
  async listReports(@Query('status') status?: string): Promise<{ data: ReportDetailView[] }> {
    const data = await this.socialService.listReports({ status });
    return { data };
  }

  // PATCH /api/v1/reports/:id — 신고 상태 변경 (관리자 전용)
  @Patch('reports/:id')
  @Roles(ROLES.ADMIN)
  async updateReportStatus(
    @Param('id') id: string,
    @Body() dto: UpdateReportStatusDto,
  ): Promise<{ data: ReportDetailView }> {
    const data = await this.socialService.updateReportStatus(id, dto.status);
    return { data };
  }

  // DELETE /api/v1/reports/:id — 신고 삭제 (관리자 전용)
  @Delete('reports/:id')
  @Roles(ROLES.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteReport(@Param('id') id: string): Promise<void> {
    await this.socialService.deleteReport(id);
  }
}
