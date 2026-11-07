import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from './ai-jobs/ai-jobs.module.js';
import { createMongooseOptions } from './config/mongo.config.js';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';

@Module({
  imports: [
    // .env를 읽어 서버 전체에서 환경변수를 쓸 수 있게함.
    ConfigModule.forRoot({ isGlobal: true }),
    // ConfigService로 MONGODB_URI를 읽어 MongoDB에 연결
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      // MONGODB_URI가 없으면 DB 연결을 시도하기 전에 바로 오류를 낸다
      useFactory: createMongooseOptions,
    }),
    AuthModule,
    // ai_jobs 작업 넣기 · 진행 상태 · 취소 · 다시 시도(#175)
    AiJobsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
