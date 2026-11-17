import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { CreateReportDto } from './dto/create-report.dto.js';
import { ReportsService } from './reports.service.js';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: CreateReportDto) {
    return { data: await this.reports.create(requireUserId(req), body) };
  }
}
