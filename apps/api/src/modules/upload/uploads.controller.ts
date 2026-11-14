import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { CreateUploadDto } from './dto/create-upload.dto.js';
import { UploadsService } from './uploads.service.js';

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post('sas')
  async issue(@Req() req: AuthenticatedRequest, @Body() body: CreateUploadDto) {
    return { data: await this.uploads.issue(requireUserId(req), body) };
  }
}
