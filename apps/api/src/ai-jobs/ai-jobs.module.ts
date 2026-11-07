import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJob, AiJobSchema } from '../modules/quiz/schemas/ai-job.schema.js';
import { AiJobsService } from './ai-jobs.service.js';

/**
 * ai_jobs 작업 넣기 · 진행 상태 · 취소 · 다시 시도(#175).
 * 앱이 부르는 주소(`/api/v1/ai-jobs/:id` · cancel · retry)는 access 토큰 검사(JwtAuthGuard)가
 * develop에 들어온 뒤 붙인다. 지금은 퀴즈 · 노트 모듈이 작업을 넣을 수 있게 서비스만 내보낸다.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: AiJob.name, schema: AiJobSchema }])],
  providers: [AiJobsService],
  exports: [AiJobsService],
})
export class AiJobsModule {}
