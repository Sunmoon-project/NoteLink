import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../../auth/auth.module.js';
import { User, UserSchema } from '../../auth/schemas/user.schema.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../../calendar/schemas/timetable-share.schema.js';
import { Friendship, FriendshipSchema } from '../schemas/friendship.schema.js';
import { FriendsController } from './friends.controller.js';
import { FriendsService } from './friends.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Friendship.name, schema: FriendshipSchema },
      { name: User.name, schema: UserSchema },
      // 친구를 끊으면 서로의 시간표 공유도 지운다(FR-15-06)
      { name: TimetableShare.name, schema: TimetableShareSchema },
    ]),
    AuthModule, // 로그인 확인(JwtAuthGuard)
  ],
  controllers: [FriendsController],
  providers: [FriendsService],
})
export class FriendsModule {}
