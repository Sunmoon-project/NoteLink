import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { StudySession, StudySessionSchema } from '../session/schemas/study-session.schema.js';
import { GoalsController } from './goals.controller.js';
import { ProgressService } from './progress.service.js';
import { RecurringGoalsController } from './recurring-goals.controller.js';
import { RecurringGoalsService } from './recurring-goals.service.js';
import { DailyRecord, DailyRecordSchema } from './schemas/daily-record.schema.js';
import { RecurringGoal, RecurringGoalSchema } from './schemas/recurring-goal.schema.js';
import { WeeklyGoal, WeeklyGoalSchema } from './schemas/weekly-goal.schema.js';
import { StudyProgressController } from './study-progress.controller.js';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: DailyRecord.name, schema: DailyRecordSchema }, // 하루 기록(순공 초)을 읽어 통계를 만든다
            { name: WeeklyGoal.name, schema: WeeklyGoalSchema },
            { name: RecurringGoal.name, schema: RecurringGoalSchema }, // 반복 목표(FR-11)
            { name: StudySession.name, schema: StudySessionSchema }, // 가장 많이 공부한 시간대(peakHour) 계산
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [GoalsController, RecurringGoalsController, StudyProgressController],
    providers: [ProgressService, RecurringGoalsService],
    exports: [ProgressService], // 프로필(GET /users/me)이 streakDays를 가져다 쓴다
})
export class ProgressModule { }
