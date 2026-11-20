import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { Category, CategorySchema } from '../content/schemas/category.schema.js';
import { StudyRoom, StudyRoomSchema } from './schemas/study-room.schema.js';
import { StudyRoomsController } from './study-rooms.controller.js';
import { StudyRoomsService } from './study-rooms.service.js';
import { StudyRoomMembershipService } from './study-room-membership.service.js';
import { ChatRoom, ChatRoomSchema } from '../social/schemas/chat-room.schema.js';
import { Message, MessageSchema } from '../social/schemas/message.schema.js';
import { StudyChatService } from './study-chat.service.js';
import { StudyChatController } from './study-chat.controller.js';
import { StudyChatGateway } from './study-chat.gateway.js';
import { StudyLiveService } from './study-live.service.js';
import { StudyRoomCleanupService } from './study-room-cleanup.service.js';
import { StudyRoomWithdrawnSweeper } from './study-room-withdrawn-sweeper.service.js';
import { Report, ReportSchema } from '../social/schemas/report.schema.js';
import { ReportsController } from '../social/reports.controller.js';
import { ReportImageSweeper } from '../social/report-image-sweeper.service.js';
import { ReportsService } from '../social/reports.service.js';
import { UploadsModule } from '../upload/uploads.module.js';
import { Friendship, FriendshipSchema } from '../social/schemas/friendship.schema.js';
import { Device, DeviceSchema } from '../users/schemas/device.schema.js';
import { ExpoPushService } from '../notification/expo-push.service.js';
import { RoomTimerNotificationsService } from './room-timer-notifications.service.js';
import { StudyRoomNoticesService } from './study-room-notices.service.js';
import { NotificationModule } from '../notification/notification.module.js';

import { Timetable, TimetableSchema } from '../calendar/schemas/timetable.schema.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../calendar/schemas/timetable-share.schema.js';
import { StudyRoomScheduleController } from './study-room-schedule.controller.js';
import { StudyRoomScheduleService } from './study-room-schedule.service.js';

@Module({
  imports: [
    AuthModule,
    UploadsModule,
    // 채팅 · 초대 · 퇴장 조치 알림, 타이머 푸시의 알림 설정 확인(#560)
    NotificationModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Category.name, schema: CategorySchema },
      { name: ChatRoom.name, schema: ChatRoomSchema },
      { name: Message.name, schema: MessageSchema },
      { name: StudyRoom.name, schema: StudyRoomSchema },
      { name: Report.name, schema: ReportSchema },
      { name: Friendship.name, schema: FriendshipSchema },
      { name: Device.name, schema: DeviceSchema },
      // 공용 일정(StudyRoomScheduleService)
      { name: Timetable.name, schema: TimetableSchema },
      // 일정 제목을 보여 줄지 정하는 시간표 공유(읽기만)
      { name: TimetableShare.name, schema: TimetableShareSchema },
    ]),
  ],
  controllers: [
    StudyRoomsController,
    StudyChatController,
    ReportsController,
    StudyRoomScheduleController,
  ],
  // 회원 탈퇴가 스터디룸에서 나가기를 쓴다(UsersModule). 소켓 · LiveKit 은 이 묶음 서비스 안에 둔다
  exports: [StudyRoomMembershipService, StudyChatService, StudyChatGateway],
  providers: [
    StudyRoomsService,
    StudyRoomMembershipService,
    StudyChatService,
    StudyChatGateway,
    StudyLiveService,
    StudyRoomCleanupService,
    StudyRoomWithdrawnSweeper,
    ExpoPushService,
    RoomTimerNotificationsService,
    StudyRoomNoticesService,
    ReportsService,
    ReportImageSweeper,
    StudyRoomScheduleService,
  ],
})
export class StudyRoomsModule {}
