import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { Category, CategorySchema } from '../content/schemas/category.schema.js';
import { StudyRoom, StudyRoomSchema } from './schemas/study-room.schema.js';
import { StudyRoomsController } from './study-rooms.controller.js';
import { StudyRoomsService } from './study-rooms.service.js';
import { ChatRoom, ChatRoomSchema } from '../social/schemas/chat-room.schema.js';
import { Message, MessageSchema } from '../social/schemas/message.schema.js';
import { StudyChatService } from './study-chat.service.js';
import { StudyChatController } from './study-chat.controller.js';
import { StudyChatGateway } from './study-chat.gateway.js';
import { StudyLiveService } from './study-live.service.js';
import { StudyRoomCleanupService } from './study-room-cleanup.service.js';
import { Report, ReportSchema } from '../social/schemas/report.schema.js';
import { ReportsController } from '../social/reports.controller.js';
import { ReportsService } from '../social/reports.service.js';
import { UploadsModule } from '../upload/uploads.module.js';
import { Friendship, FriendshipSchema } from '../social/schemas/friendship.schema.js';

@Module({
  imports: [
    AuthModule,
    UploadsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Category.name, schema: CategorySchema },
      { name: ChatRoom.name, schema: ChatRoomSchema },
      { name: Message.name, schema: MessageSchema },
      { name: StudyRoom.name, schema: StudyRoomSchema },
      { name: Report.name, schema: ReportSchema },
      { name: Friendship.name, schema: FriendshipSchema },
    ]),
  ],
  controllers: [StudyRoomsController, StudyChatController, ReportsController],
  providers: [
    StudyRoomsService,
    StudyChatService,
    StudyChatGateway,
    StudyLiveService,
    StudyRoomCleanupService,
    ReportsService,
  ],
})
export class StudyRoomsModule {}
