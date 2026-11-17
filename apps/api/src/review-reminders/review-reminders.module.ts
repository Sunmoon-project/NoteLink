import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../modules/auth/schemas/user.schema.js';
import { ExpoPushService } from '../modules/notification/expo-push.service.js';
import { QuizSet, QuizSetSchema } from '../modules/quiz/schemas/quiz-set.schema.js';
import { Device, DeviceSchema } from '../modules/users/schemas/device.schema.js';
import { ReviewReminder, ReviewReminderSchema } from './review-reminder.schema.js';
import { ReviewRemindersService } from './review-reminders.service.js';

/**
 * 오늘 복습할 문제가 있는 날 푸시를 보낸다(FR-37-08). 퀴즈 · 오늘의 복습 모듈과 따로 둔 새 모듈이다
 * (quiz_sets · users 는 읽기만 하고, 하루 한 번 표시는 새 컬렉션 review_reminders 에 둔다).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: QuizSet.name, schema: QuizSetSchema }, // 복습할 문제 집계 · 오늘의 복습 세트 확인(읽기만)
      { name: ReviewReminder.name, schema: ReviewReminderSchema }, // 사용자 · 날짜마다 한 번 표시
      { name: Device.name, schema: DeviceSchema }, // 푸시를 받을 기기(읽기, 만료 토큰 삭제)
      { name: User.name, schema: UserSchema }, // 탈퇴 중 · 탈퇴한 사용자 확인(읽기만)
    ]),
  ],
  providers: [
    ReviewRemindersService,
    ExpoPushService, // 상태 없는 클래스라 여기에도 하나 둔다(다른 푸시 모듈과 같은 방식)
  ],
})
export class ReviewRemindersModule {}
