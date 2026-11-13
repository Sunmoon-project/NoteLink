import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { QuizBoxController } from './quiz-box.controller.js';
import { QuizBoxService } from './quiz-box.service.js';
import { QuizBoxCounter, QuizBoxCounterSchema } from './schemas/quiz-box-counter.schema.js';
import { QuizBoxItem, QuizBoxItemSchema } from './schemas/quiz-box-item.schema.js';
import { QuizSet, QuizSetSchema } from './schemas/quiz-set.schema.js';

/** 퀴즈 보관함 저장 · 조회 · 삭제 (FR-57 · 58). QuizSetsModule · QuizAttemptsModule은 가져오지 않는다 */
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: QuizBoxItem.name, schema: QuizBoxItemSchema },
            { name: QuizBoxCounter.name, schema: QuizBoxCounterSchema },
            { name: QuizSet.name, schema: QuizSetSchema }, // 내 세트인지 · 문제 내용을 읽기만 한다
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [QuizBoxController],
    providers: [QuizBoxService],
})
export class QuizBoxModule { }
