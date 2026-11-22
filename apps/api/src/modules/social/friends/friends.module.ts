import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../../auth/auth.module.js';
import { User, UserSchema } from '../../auth/schemas/user.schema.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../../calendar/schemas/timetable-share.schema.js';
import { NotificationModule } from '../../notification/notification.module.js';
import { FriendSharedItem, FriendSharedItemSchema } from '../schemas/friend-shared-item.schema.js';
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
      // 친구를 끊으면 그 관계로 보낸 노트 공유도 지운다(#554)
      { name: FriendSharedItem.name, schema: FriendSharedItemSchema },
    ]),
    AuthModule, // 로그인 확인(JwtAuthGuard)
    NotificationModule, // 친구 요청 · 수락 알림(FR-15-04)
  ],
  controllers: [FriendsController],
  providers: [FriendsService],
})
export class FriendsModule {}
