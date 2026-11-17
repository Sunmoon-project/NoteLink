import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from '../../../ai-jobs/ai-jobs.module.js';
import { QuizSetsModule } from '../../../quiz-sets/quiz-sets.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { AiJob, AiJobSchema } from '../../quiz/schemas/ai-job.schema.js';
import { UploadsModule } from '../../upload/uploads.module.js';
import { Folder, FolderSchema } from '../schemas/folder.schema.js';
import { Material, MaterialSchema } from '../schemas/material.schema.js';
import { MaterialsController } from './materials.controller.js';
import { MaterialsService } from './materials.service.js';
import { RecordingController } from './recording.controller.js';
import { RecordingService } from './recording.service.js';

/**
 * 노트(자료) 등록 · 조회 · 수정 · 삭제. 정리는 AI 작업(ai-jobs)으로 하고, 올린 파일의 읽기 주소는
 * 저장소 서비스(upload)로 만든다. 순환 의존은 없다(ai-jobs · quiz-sets · upload 는 이 모듈을 모른다).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Material.name, schema: MaterialSchema },
      { name: Folder.name, schema: FolderSchema },
      // 녹음 재생 정보가 정리 결과에서 필요한 부분만 읽는다(RecordingService)
      { name: AiJob.name, schema: AiJobSchema },
    ]),
    AiJobsModule,
    QuizSetsModule,
    UploadsModule,
    // JwtAuthGuard · TokenService
    AuthModule,
  ],
  controllers: [MaterialsController, RecordingController],
  providers: [MaterialsService, RecordingService],
})
export class MaterialsModule {}
