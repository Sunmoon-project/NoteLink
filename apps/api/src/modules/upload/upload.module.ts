import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { createStorageConfig } from '../../config/storage.config.js';
import { AuthModule } from '../auth/auth.module.js';
import { BLOB_STORE, createBlobStore } from './blob-store.js';
import { UploadTicket, UploadTicketSchema } from './schemas/upload-ticket.schema.js';
import { UploadSweeper } from './upload-sweeper.service.js';
import { UploadController } from './upload.controller.js';
import { STORAGE_CONFIG, UploadService } from './upload.service.js';

/** 파일 올리기 주소 발급: 앱은 받은 주소로 Azure Blob에 바로 올리고, 서버는 올라간 파일을 뒤에 확인 · 정리한다 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: UploadTicket.name, schema: UploadTicketSchema }]),
    AuthModule,
  ],
  controllers: [UploadController],
  providers: [
    { provide: STORAGE_CONFIG, inject: [ConfigService], useFactory: createStorageConfig },
    { provide: BLOB_STORE, inject: [STORAGE_CONFIG], useFactory: createBlobStore },
    UploadService,
    UploadSweeper,
  ],
})
export class UploadModule {}
