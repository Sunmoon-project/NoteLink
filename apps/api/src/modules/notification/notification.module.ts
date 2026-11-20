import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { Device, DeviceSchema } from '../users/schemas/device.schema.js';
import { ExpoPushService } from './expo-push.service.js';
import { NotificationController } from './notification.controller.js';
import { NotificationService } from './notification.service.js';
import { Notification, NotificationSchema } from './schemas/notification.schema.js';

/** 공통 알림(알림함 저장 + 푸시)과 알림함 API. 알림을 보내는 모듈은 이 모듈을 import해 NotificationService를 쓴다 */
@Module({
  imports: [
    AuthModule, // 로그인 확인(JwtAuthGuard)
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: User.name, schema: UserSchema }, // 알림 설정(settings.notify*)
      { name: Device.name, schema: DeviceSchema },
    ]),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, ExpoPushService],
  exports: [NotificationService],
})
export class NotificationModule {}
