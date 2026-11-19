import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { HolidaysModule } from '../calendar/holidays.module.js';
import { Todo, TodoSchema } from '../calendar/schemas/todo.schema.js';
import { ExpoPushService } from '../notification/expo-push.service.js';
import { NotificationModule } from '../notification/notification.module.js';
import { Subject, SubjectSchema } from '../session/schemas/subject.schema.js';
import { StudySession, StudySessionSchema } from '../session/schemas/study-session.schema.js';
import { Device, DeviceSchema } from '../users/schemas/device.schema.js';
import { GoalRemindersService } from './goal-reminders.service.js';
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
        NotificationModule, // 목표 리마인드가 공부 알림 설정을 따른다(#560)
        MongooseModule.forFeature([
            { name: DailyRecord.name, schema: DailyRecordSchema }, // 하루 기록(순공 초)을 읽어 통계를 만든다
            { name: WeeklyGoal.name, schema: WeeklyGoalSchema },
            { name: RecurringGoal.name, schema: RecurringGoalSchema }, // 반복 목표(FR-11)
            { name: Subject.name, schema: SubjectSchema }, // 반복 목표의 과목이 있는지 확인한다 (읽기만)
            { name: Todo.name, schema: TodoSchema }, // 월간 캘린더 hasTodo: 할 일 날짜를 읽기만 한다 (CalendarModule은 가져오지 않는다)
            { name: StudySession.name, schema: StudySessionSchema }, // 가장 많이 공부한 시간대(peakHour) 계산
            { name: Device.name, schema: DeviceSchema }, // 목표 리마인드 푸시를 받을 기기(읽기, 만료 토큰 삭제)
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
        HolidaysModule, // 반복 목표 판정에서 건너뛸 날(공휴일 · 내 제외일)을 물어본다 (HolidaysService)
    ],
    controllers: [GoalsController, RecurringGoalsController, StudyProgressController],
    providers: [
        ProgressService,
        RecurringGoalsService,
        GoalRemindersService, // 목표 리마인드 푸시(FR-11-07)
        ExpoPushService, // 상태 없는 클래스라 스터디룸과 따로 하나 더 둔다(스터디룸 모듈을 가져오면 타이머 스케줄러까지 딸려 온다)
    ],
    exports: [ProgressService], // 프로필(GET /users/me)이 streakDays를 가져다 쓴다
})
export class ProgressModule { }
