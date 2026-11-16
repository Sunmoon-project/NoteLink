import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BlobStorageService } from './blob-storage.service.js';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UploadsController],
  providers: [UploadsService, BlobStorageService],
  exports: [BlobStorageService],
})
export class UploadsModule {}
