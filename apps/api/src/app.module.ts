import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { HealthController } from './health/health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { SocialModule } from './modules/social/social.module.js';
import { StudyroomModule } from './modules/studyroom/studyroom.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGODB_URL'),
        // DB가 응답 없을 때 무한 대기하지 않고 빠르게 실패합니다.
        serverSelectionTimeoutMS: 5000,
      }),
    }),
    AuthModule,
    StudyroomModule,
    SocialModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
