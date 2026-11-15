import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from '../../../ai-jobs/ai-jobs.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { UploadsModule } from '../../upload/uploads.module.js';
import { Folder, FolderSchema } from '../schemas/folder.schema.js';
import { Material, MaterialSchema } from '../schemas/material.schema.js';
import { MaterialsController } from './materials.controller.js';
import { MaterialsService } from './materials.service.js';

/**
 * 노트(자료) 등록 · 조회 · 수정 · 삭제. 정리는 AI 작업(ai-jobs)으로 하고, 올린 파일의 읽기 주소는
 * 저장소 서비스(upload)로 만든다. 순환 의존은 없다(ai-jobs · upload 는 노트를 모른다).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Material.name, schema: MaterialSchema },
      { name: Folder.name, schema: FolderSchema },
    ]),
    AiJobsModule,
    UploadsModule,
    // JwtAuthGuard · TokenService
    AuthModule,
  ],
  controllers: [MaterialsController],
  providers: [MaterialsService],
})
export class MaterialsModule {}
