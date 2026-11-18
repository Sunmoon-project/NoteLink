import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { DailyRecord, DailyRecordSchema } from '../progress/schemas/daily-record.schema.js';
import { CalendarSharesController } from './calendar-shares.controller.js';
import { CalendarSharesService } from './calendar-shares.service.js';
import { CalendarShare, CalendarShareSchema } from './schemas/calendar-share.schema.js';
import { Todo, TodoSchema } from './schemas/todo.schema.js';

// 캘린더 공유 링크 (FR-13). 할 일 · 공부 기록 · 사용자 모델은 읽기만 하려고 여기서 직접 등록한다
// (CalendarModule · ProgressModule · HolidaysModule은 가져오지 않는다)
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: CalendarShare.name, schema: CalendarShareSchema },
            { name: Todo.name, schema: TodoSchema }, // 공유 기간의 할 일 날짜 (읽기만)
            { name: DailyRecord.name, schema: DailyRecordSchema }, // 공유 기간의 공부 기록 날짜 (읽기만)
            { name: User.name, schema: UserSchema }, // 공유한 사람의 닉네임 (읽기만)
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [CalendarSharesController],
    providers: [CalendarSharesService],
})
export class CalendarSharesModule { }
