import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from './ai-jobs/ai-jobs.module.js';
import { createMongooseOptions } from './config/mongo.config.js';
import { HealthController } from './health/health.controller.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { CalendarModule } from './modules/calendar/calendar.module.js';
import { HolidaysModule } from './modules/calendar/holidays.module.js';
import { FoldersModule } from './modules/content/folders/folders.module.js';
import { NoteAskModule } from './modules/content/note-ask/note-ask.module.js';
import { ProgressModule } from './modules/progress/progress.module.js';
import { RewardModule } from './modules/reward/reward.module.js';
import { StudyRoomsModule } from './modules/studyroom/study-rooms.module.js';
import { FlashcardsModule } from './modules/quiz/flashcards.module.js';
import { QuizAttemptsModule } from './modules/quiz/quiz-attempts.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { QuizSetsModule } from './quiz-sets/quiz-sets.module.js';
import { SessionModule } from './modules/session/session.module.js';
import { TimetableModule } from './modules/timetable/timetable.module.js';
import { FriendsModule } from './modules/social/friends/friends.module.js';

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

    // 내 프로필 조회, 수정 등 사용자 API
    UsersModule,

    // ai_jobs 작업 넣기 · 진행 상태 · 취소 · 다시 시도(#175)
    AiJobsModule,
    // 상점 · 포인트(FR-59~63)
    RewardModule,
    StudyRoomsModule,
    // 맞춤 퀴즈 세트 만들기 · 조회 · 작업 결과 반영(#175)
    QuizSetsModule,
    NoteAskModule,
    // 공부 시간 · 타이머(FR-06~08)
    SessionModule,
    // 이번 주 목표 · 요약(FR-06-20 · FR-06-24)
    ProgressModule,
    // 퀴즈 풀이 시작 · 답 제출 채점(FR-49·50)
    QuizAttemptsModule,
    // 플래시카드 저장 · 조회 · 삭제(FR-55 · 56)
    FlashcardsModule,
    // 시간표 · 수업 · 친구 공유(FR-14)
    TimetableModule,
    // 친구 찾기 · 요청 · 목록 · 삭제(FR-15)
    FriendsModule,
    // 할 일 · D-day (FR-10)
    CalendarModule,
    // 공휴일 · 사용자 제외일 (FR-12)
    HolidaysModule,
    // 학습 폴더 목록 · 만들기(FR-19)
    FoldersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
