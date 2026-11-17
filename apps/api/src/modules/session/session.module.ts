import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { RewardModule } from '../reward/reward.module.js';
import { DailyRecord, DailyRecordSchema } from '../progress/schemas/daily-record.schema.js';
import { StudySession, StudySessionSchema } from './schemas/study-session.schema.js';
import { Subject, SubjectSchema } from './schemas/subject.schema.js';
import { StudySessionsController } from './study-sessions.controller.js';
import { StudyController } from './study.controller.js';
import { StudyService } from './study.service.js';
import { SubjectsController } from './subjects.controller.js';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: StudySession.name, schema: StudySessionSchema },
            { name: DailyRecord.name, schema: DailyRecordSchema },
            { name: Subject.name, schema: SubjectSchema },
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
        RewardModule, // 세션이 끝날 때 포인트를 적립하려고 PointService를 가져온다
    ],
    controllers: [StudyController, SubjectsController, StudySessionsController],
    providers: [StudyService],
})
export class SessionModule { }
