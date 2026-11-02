import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RolesGuard } from '../../common/roles.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { StudyroomModule } from '../studyroom/studyroom.module.js';
import { Report, ReportSchema } from './schemas/report.schema.js';
import { SocialController } from './social.controller.js';
import { SocialService } from './social.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Report.name, schema: ReportSchema }]),
    // StudyRoom 모델은 StudyroomModule이 내보낸 것을 재사용합니다(중복 등록 방지).
    StudyroomModule,
    AuthModule, // JwtAuthGuard
  ],
  controllers: [SocialController],
  providers: [SocialService, RolesGuard],
  exports: [MongooseModule, SocialService],
})
export class SocialModule {}
