import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from './ai-jobs/ai-jobs.module.js';
import { createMongooseOptions } from './config/mongo.config.js';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { RewardModule } from './modules/reward/reward.module.js';
import { QuizSetsModule } from './quiz-sets/quiz-sets.module.js';
import { TimetableModule } from './modules/timetable/timetable.module.js';

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
    // 상점 · 포인트(FR-59~63)=
    RewardModule,
    // 맞춤 퀴즈 세트 만들기 · 조회 · 작업 결과 반영(#175)
    QuizSetsModule,
    // 시간표 · 수업 · 친구 공유(FR-14)
    TimetableModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
