import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { createStorageConfig } from '../../config/storage.config.js';
import { AuthModule } from '../auth/auth.module.js';
import { UploadQuota, UploadQuotaSchema } from './schemas/upload-quota.schema.js';
import { UploadQuotaService } from './upload-quota.service.js';
import { UploadController } from './upload.controller.js';
import { STORAGE_CONFIG, UploadService } from './upload.service.js';

/** 파일 올리기 주소 발급: 앱은 받은 주소로 Azure Blob에 바로 올린다 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: UploadQuota.name, schema: UploadQuotaSchema }]),
    AuthModule,
  ],
  controllers: [UploadController],
  providers: [
    { provide: STORAGE_CONFIG, inject: [ConfigService], useFactory: createStorageConfig },
    UploadQuotaService,
    UploadService,
  ],
})
export class UploadModule {}
