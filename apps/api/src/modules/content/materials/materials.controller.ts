import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AiJob, Material } from '@notelink/shared';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { CreateMaterialDto } from './dto/create-material.dto.js';
import { UpdateMaterialDto } from './dto/update-material.dto.js';
import { MaterialsService, parseIdempotencyKey } from './materials.service.js';

/** 노트(자료) 주소 (packages/shared PATHS.materials · material · folderMaterials) */
@Controller()
@UseGuards(JwtAuthGuard)
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  /** 노트 등록. Idempotency-Key 헤더가 있으면 같은 키의 재요청은 같은 결과를 돌려준다 */
  @Post('materials')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateMaterialDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<{ data: { material: Material; job: AiJob } }> {
    return {
      data: (await this.materials.register(requireUserId(req), body, parseIdempotencyKey(key))) as {
        material: Material;
        job: AiJob;
      },
    };
  }

  /** 노트 한 개. 정리 중이면 끝난 작업의 결과를 먼저 옮긴다 */
  @Get('materials/:id')
  async findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: Material }> {
    return { data: (await this.materials.findMine(requireUserId(req), id)) as Material };
  }

  /** 원본 파일(올린 첫 파일)의 내려받기 주소: 읽기 SAS 1시간 + 파일 이름 */
  @Get('materials/:id/download-url')
  async downloadUrl(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: { url: string; fileName: string } }> {
    return { data: await this.materials.downloadUrl(requireUserId(req), id) };
  }

  /** 폴더 안의 노트(최근 순, 정리 중인 노트 포함) */
  @Get('folders/:id/materials')
  async listInFolder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: Material[] }> {
    return { data: (await this.materials.listInFolder(requireUserId(req), id)) as Material[] };
  }

  /** 저장({ saved: true }) 또는 요약 수정({ summary: { sections } }) */
  @Patch('materials/:id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: UpdateMaterialDto,
  ): Promise<{ data: Material }> {
    return { data: (await this.materials.update(requireUserId(req), id, body)) as Material };
  }

  @Delete('materials/:id')
  @HttpCode(204)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.materials.remove(requireUserId(req), id);
  }
}
