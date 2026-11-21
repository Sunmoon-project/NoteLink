import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { QuizSetsModule } from '../../../quiz-sets/quiz-sets.module.js';
import { AuthModule } from '../../auth/auth.module.js';
import { Subject, SubjectSchema } from '../../session/schemas/subject.schema.js';
import { Folder, FolderSchema } from '../schemas/folder.schema.js';
import { Material, MaterialSchema } from '../schemas/material.schema.js';
import { FoldersController } from './folders.controller.js';
import { FoldersService } from './folders.service.js';

/** 노트 탭의 학습 폴더 목록 · 만들기 · 지우기. 지울 때 그 폴더의 퀴즈 · 카드 · 보관함 항목도 지운다(QuizSetsModule, #602) */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Folder.name, schema: FolderSchema },
      { name: Material.name, schema: MaterialSchema },
      { name: Subject.name, schema: SubjectSchema },
    ]),
    AuthModule,
    QuizSetsModule,
  ],
  controllers: [FoldersController],
  providers: [FoldersService],
})
export class FoldersModule {}
