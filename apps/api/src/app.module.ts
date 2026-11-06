import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { HealthController } from './health/health.controller.js';

@Module({
  imports: [
    // .env를 읽어 서버 전체에서 환경변수를 쓸 수 있게함.
    ConfigModule.forRoot({ isGlobal: true }),
    // ConfigService로 MONGODB_URI를 읽어 MongoDB에 연결
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // 값이 없으면 DB 연결을 시도하기 전에 바로 오류를 낸다
        uri: config.getOrThrow<string>('MONGODB_URI'),
      }),
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
