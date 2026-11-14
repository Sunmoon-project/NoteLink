import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { createStorageConfig } from '../../config/storage.config.js';
import { AuthModule } from '../auth/auth.module.js';
import { BlobStorageService, STORAGE_CONFIG } from './blob-storage.service.js';
import { UploadQuota, UploadQuotaSchema } from './schemas/upload-quota.schema.js';
import { UploadQuotaService } from './upload-quota.service.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

/** 파일 올리기 주소 발급과 올린 파일 확인 · 보관. 앱은 받은 주소로 Azure Blob에 바로 올린다 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: UploadQuota.name, schema: UploadQuotaSchema }]),
    AuthModule,
  ],
  controllers: [UploadsController],
  providers: [
    { provide: STORAGE_CONFIG, inject: [ConfigService], useFactory: createStorageConfig },
    BlobStorageService,
    UploadQuotaService,
    UploadsService,
  ],
  exports: [BlobStorageService],
})
export class UploadsModule {}
