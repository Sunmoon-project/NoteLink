import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Material, MaterialSchema } from '../modules/content/schemas/material.schema.js';
import { ExpoPushService } from '../modules/notification/expo-push.service.js';
import { NotificationModule } from '../modules/notification/notification.module.js';
import { AiJob, AiJobSchema } from '../modules/quiz/schemas/ai-job.schema.js';
import { QuizSet, QuizSetSchema } from '../modules/quiz/schemas/quiz-set.schema.js';
import { Device, DeviceSchema } from '../modules/users/schemas/device.schema.js';
import { AiJobNoticesService } from './ai-job-notices.service.js';

/**
 * 노트 변환(요약 작업) · 퀴즈 만들기가 끝나면 알림함에 남기고 푸시를 보낸다(FR-65-02, #560).
 * AiJobsModule과 따로 둔 새 모듈이다(작업 넣기 · 조회 · 다시 시도 코드와 섞지 않는다).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AiJob.name, schema: AiJobSchema }, // 끝난 작업 찾기 · 알림 상태 기록
      { name: Material.name, schema: MaterialSchema }, // 보내기 전 노트 확인(읽기만)
      { name: Device.name, schema: DeviceSchema }, // 푸시를 받을 기기(읽기, 만료 토큰 삭제)
      { name: QuizSet.name, schema: QuizSetSchema }, // 보내기 전 퀴즈 세트 확인(읽기만)
    ]),
    NotificationModule, // 알림함 저장 · AI 알림 설정(#560)
  ],
  providers: [
    AiJobNoticesService,
    ExpoPushService, // 상태 없는 클래스라 여기에도 하나 둔다(ProgressModule과 같은 방식)
  ],
})
export class AiJobNoticesModule {}
