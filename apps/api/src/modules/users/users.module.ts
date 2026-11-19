import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../auth/schemas/user.schema.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../calendar/schemas/timetable-share.schema.js';
import { Friendship, FriendshipSchema } from '../social/schemas/friendship.schema.js';
import { Device, DeviceSchema } from './schemas/device.schema.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { InterestCategorySeedService } from './interest-category-seed.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { ProgressModule } from '../progress/progress.module.js';
import { StudyRoomsModule } from '../studyroom/study-rooms.module.js';

@Module({
  imports: [
    AuthModule,
    MailModule, // 이메일 본인 인증번호 메일
    ProgressModule, // 프로필의 연속 학습일(streakDays)
    StudyRoomsModule, // 탈퇴할 때 스터디룸에서 나간다(leaveRoom)
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Device.name, schema: DeviceSchema },
      // 탈퇴할 때 친구 · 시간표 공유를 정리한다(로그인은 AuthModule의 TokenService로 끊는다)
      { name: Friendship.name, schema: FriendshipSchema },
      { name: TimetableShare.name, schema: TimetableShareSchema },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService, InterestCategorySeedService],
})
export class UsersModule {}
