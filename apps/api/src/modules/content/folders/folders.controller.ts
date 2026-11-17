import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { type AppFolder, FoldersService } from './folders.service.js';

/** GET · POST /api/v1/folders, DELETE /api/v1/folders/:id (packages/shared PATHS.folders · folder) */
@Controller('folders')
@UseGuards(JwtAuthGuard)
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ data: (AppFolder & { materialCount: number })[] }> {
    return { data: await this.folders.list(requireUserId(req)) };
  }

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ data: AppFolder }> {
    return { data: await this.folders.create(requireUserId(req), body) };
  }

  /** 폴더와 안의 노트를 함께 지운다 */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.folders.remove(requireUserId(req), id);
  }
}
