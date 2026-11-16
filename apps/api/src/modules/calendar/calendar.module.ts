import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { Subject, SubjectSchema } from '../session/schemas/subject.schema.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { Todo, TodoSchema } from './schemas/todo.schema.js';

// 할 일 · D-day (FR-10). 공휴일 · 캘린더 공유는 각자 따로 모듈로 만든다
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Todo.name, schema: TodoSchema },
            { name: Subject.name, schema: SubjectSchema }, // 과목 이름으로 과목 id를 찾는다 (읽기만)
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [CalendarController],
    providers: [CalendarService],
})
export class CalendarModule { }
