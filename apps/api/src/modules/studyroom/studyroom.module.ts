import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ChatGateway } from '../../realtime/chat.gateway.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChatRoom, ChatRoomSchema } from '../social/schemas/chat-room.schema.js';
import { Message, MessageSchema } from '../social/schemas/message.schema.js';
import { ChatService } from './chat.service.js';
import { StudyRoom, StudyRoomSchema } from './schemas/study-room.schema.js';
import { ChatRoomsController, StudyroomController } from './studyroom.controller.js';
import { StudyroomService } from './studyroom.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: StudyRoom.name, schema: StudyRoomSchema },
      { name: ChatRoom.name, schema: ChatRoomSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
    // JwtAuthGuard와 소켓 JWT 검증을 위해 Auth 모듈(JwtModule 포함)을 가져옵니다.
    AuthModule,
  ],
  controllers: [StudyroomController, ChatRoomsController],
  providers: [StudyroomService, ChatService, ChatGateway],
  exports: [MongooseModule, StudyroomService, ChatService],
})
export class StudyroomModule {}
