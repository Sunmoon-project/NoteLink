import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { AiJob, Material } from '@notelink/shared';
import type { Response } from 'express';

import { requireUserId } from '../../../common/request-user.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { AddBookmarkDto } from './dto/add-bookmark.dto.js';
import { CreateMaterialDto } from './dto/create-material.dto.js';
import { ListMaterialsQuery } from './dto/list-materials.query.js';
import { UpdateMaterialDto } from './dto/update-material.dto.js';
import { encodeCursor, NEXT_CURSOR_HEADER, parseListQuery } from './list-cursor.js';
import { MaterialSharingService } from './material-sharing.service.js';
import { MaterialsService, parseIdempotencyKey } from './materials.service.js';

/** 노트(자료) 주소 (packages/shared PATHS.materials · material · folderMaterials) */
@Controller()
@UseGuards(JwtAuthGuard)
export class MaterialsController {
  constructor(
    private readonly materials: MaterialsService,
    private readonly sharing: MaterialSharingService,
  ) {}

  /**
   * 노트를 읽는다. 내 노트면 그대로, 아니면(404) 내가 현재 멤버인 방에 공유된 노트일 때만 노트 주인 기준으로 읽는다.
   * 공유받은 사람은 읽기만 한다 — 수정 · 삭제 · 북마크 · 목록 등 나머지는 주인만(여기를 거치지 않는다)
   */
  private async readAsOwnerOrSharedMember<T>(
    userId: string,
    id: string,
    read: (ownerId: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await read(userId);
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
      const ownerId = await this.sharing.ownerOfShared(userId, id);
      if (!ownerId) throw e;
      return read(ownerId);
    }
  }

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
    const data = await this.readAsOwnerOrSharedMember(requireUserId(req), id, (owner) =>
      this.materials.findMine(owner, id),
    );
    return { data: data as Material };
  }

  /** 원본 파일(올린 첫 파일)의 내려받기 주소: 읽기 SAS 1시간 + 파일 이름 */
  @Get('materials/:id/download-url')
  async downloadUrl(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: { url: string; fileName: string } }> {
    return {
      data: await this.readAsOwnerOrSharedMember(requireUserId(req), id, (owner) =>
        this.materials.downloadUrl(owner, id),
      ),
    };
  }

  /**
   * 폴더 안의 노트(최근 순, 정리 중인 노트 포함). 본문은 항상 배열이다.
   * 쿼리 limit(1~100) · cursor 는 선택: 둘 다 없으면 전체, limit 이 있으면 그만큼만 주고 다음 페이지가 있을 때
   * 응답 헤더 X-Next-Cursor 에 다음 cursor 를 준다(cursor 는 limit 과 함께)
   */
  @Get('folders/:id/materials')
  async listInFolder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: ListMaterialsQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ data: Material[] }> {
    const page = await this.materials.listPage(requireUserId(req), id, parseListQuery(query));
    if (page.next) res.setHeader(NEXT_CURSOR_HEADER, encodeCursor(page.next));
    return { data: page.items as Material[] };
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

  /** 녹음 북마크 추가(받은 시각 그대로, 같은 값은 한 번만, 노트당 BOOKMARK_MAX 개). 본문 없이 204 */
  @Post('materials/:id/bookmarks')
  @HttpCode(204)
  async addBookmark(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: AddBookmarkDto,
  ): Promise<void> {
    await this.materials.addBookmark(requireUserId(req), id, body.atSec);
  }

  @Delete('materials/:id')
  @HttpCode(204)
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.materials.remove(requireUserId(req), id);
  }
}
