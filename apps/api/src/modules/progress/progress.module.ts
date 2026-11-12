import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { GoalsController } from './goals.controller.js';
import { ProgressService } from './progress.service.js';
import { DailyRecord, DailyRecordSchema } from './schemas/daily-record.schema.js';
import { WeeklyGoal, WeeklyGoalSchema } from './schemas/weekly-goal.schema.js';
import { StudyProgressController } from './study-progress.controller.js';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: DailyRecord.name, schema: DailyRecordSchema }, // 하루 기록(순공 초)을 읽어 통계를 만든다
            { name: WeeklyGoal.name, schema: WeeklyGoalSchema },
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [GoalsController, StudyProgressController],
    providers: [ProgressService],
})
export class ProgressModule { }
