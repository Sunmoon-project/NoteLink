import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AiJobsModule } from '../../../ai-jobs/ai-jobs.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { QuizSet, QuizSetSchema } from '../../quiz/schemas/quiz-set.schema.js';
import { Material, MaterialSchema } from '../schemas/material.schema.js';
import { Recording, RecordingSchema } from '../schemas/recording.schema.js';
import { NoteAskController } from './note-ask.controller.js';
import { NoteAskService } from './note-ask.service.js';

/** 아바타 노트 묻고 답하기: 질문을 note_ask 작업으로 넣는다(답은 apps/ai 처리기가 쓴다) */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Material.name, schema: MaterialSchema },
      { name: Recording.name, schema: RecordingSchema },
      { name: QuizSet.name, schema: QuizSetSchema },
    ]),
    AuthModule,
    AiJobsModule,
  ],
  controllers: [NoteAskController],
  providers: [NoteAskService],
})
export class NoteAskModule {}
