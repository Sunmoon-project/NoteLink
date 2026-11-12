import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createStorageConfig } from '../../config/storage.config.js';
import { AuthModule } from '../auth/auth.module.js';
import { UploadController } from './upload.controller.js';
import { STORAGE_CONFIG, UploadService } from './upload.service.js';

/** 파일 올리기 주소 발급: 앱은 받은 주소로 Azure Blob에 바로 올린다 */
@Module({
  imports: [AuthModule],
  controllers: [UploadController],
  providers: [
    { provide: STORAGE_CONFIG, inject: [ConfigService], useFactory: createStorageConfig },
    UploadService,
  ],
})
export class UploadModule {}
