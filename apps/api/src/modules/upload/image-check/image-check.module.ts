import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module.js';
import { UploadsModule } from '../uploads.module.js';
import { ImageCheckService } from './image-check.service.js';
import { ImagesController } from './images.controller.js';

/** 필기 사진 검사. 올린 파일 확인은 저장소 서비스(UploadsModule 이 내보냄)로 한다 */
@Module({
  imports: [UploadsModule, AuthModule],
  controllers: [ImagesController],
  providers: [ImageCheckService],
})
export class ImageCheckModule {}
