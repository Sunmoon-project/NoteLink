import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { AiJob, Material } from '@notelink/shared';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { CreateMaterialDto } from './dto/create-material.dto.js';
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
}
