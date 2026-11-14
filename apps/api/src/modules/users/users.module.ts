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
import { AuthModule } from '../auth/auth.module.js';
import { ProgressModule } from '../progress/progress.module.js';

@Module({
  imports: [
    AuthModule,
    ProgressModule, // 프로필의 연속 학습일(streakDays)
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Device.name, schema: DeviceSchema },
      // 탈퇴할 때 친구 · 시간표 공유를 정리한다(로그인은 AuthModule의 TokenService로 끊는다)
      { name: Friendship.name, schema: FriendshipSchema },
      { name: TimetableShare.name, schema: TimetableShareSchema },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
