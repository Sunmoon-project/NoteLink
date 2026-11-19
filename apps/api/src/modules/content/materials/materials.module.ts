import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from '../../../ai-jobs/ai-jobs.module.js';
import { QuizSetsModule } from '../../../quiz-sets/quiz-sets.module.js';
import { User, UserSchema } from '../../auth/schemas/user.schema.js';
import { AuthModule } from '../../auth/auth.module.js';
import { NotificationModule } from '../../notification/notification.module.js';
import { AiJob, AiJobSchema } from '../../quiz/schemas/ai-job.schema.js';
import { UploadsModule } from '../../upload/uploads.module.js';
import {
  RoomSharedItem,
  RoomSharedItemSchema,
} from '../../studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom, StudyRoomSchema } from '../../studyroom/schemas/study-room.schema.js';
import { StudyRoomsModule } from '../../studyroom/study-rooms.module.js';
import { Folder, FolderSchema } from '../schemas/folder.schema.js';
import { Material, MaterialSchema } from '../schemas/material.schema.js';
import { MaterialSharingController } from './material-sharing.controller.js';
import { MaterialSharingService } from './material-sharing.service.js';
import { MaterialsController } from './materials.controller.js';
import { MaterialsService } from './materials.service.js';
import { RecordingController } from './recording.controller.js';
import { RecordingService } from './recording.service.js';

/**
 * 노트(자료) 등록 · 조회 · 수정 · 삭제. 정리는 AI 작업(ai-jobs)으로 하고, 올린 파일의 읽기 주소는
 * 저장소 서비스(upload)로 만든다. 순환 의존은 없다(ai-jobs · quiz-sets · upload 는 이 모듈을 모른다).
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Material.name, schema: MaterialSchema },
      { name: Folder.name, schema: FolderSchema },
      // 녹음 재생 정보가 정리 결과에서 필요한 부분만 읽는다(RecordingService)
      { name: AiJob.name, schema: AiJobSchema },
      // 노트 공유: 스터디룸 · 공유 항목 스키마는 읽기만 한다(스터디룸 서비스는 쓰지 않는다)
      { name: StudyRoom.name, schema: StudyRoomSchema },
      { name: RoomSharedItem.name, schema: RoomSharedItemSchema },
      // 공유한 사람의 닉네임
      { name: User.name, schema: UserSchema },
    ]),
    AiJobsModule,
    // 방에 노트를 공유하면 다른 멤버에게 알림(#560)
    NotificationModule,
    QuizSetsModule,
    UploadsModule,
    // JwtAuthGuard · TokenService
    AuthModule,
    // 방에 노트를 공유하면 방 채팅에 자료 카드(StudyChatGateway). 스터디룸 모듈은 이 모듈을 모른다
    StudyRoomsModule,
  ],
  controllers: [MaterialsController, RecordingController, MaterialSharingController],
  providers: [MaterialsService, RecordingService, MaterialSharingService],
})
export class MaterialsModule {}
