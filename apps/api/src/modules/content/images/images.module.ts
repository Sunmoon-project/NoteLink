import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module.js';
import { UploadsModule } from '../../upload/uploads.module.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';

@Module({
  imports: [AuthModule, UploadsModule],
  controllers: [ImagesController],
  providers: [ImagesService],
})
export class ImagesModule {}
