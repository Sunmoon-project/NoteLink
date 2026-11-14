import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../../auth/auth.module.js';
import { Subject, SubjectSchema } from '../../session/schemas/subject.schema.js';
import { Folder, FolderSchema } from '../schemas/folder.schema.js';
import { Material, MaterialSchema } from '../schemas/material.schema.js';
import { FoldersController } from './folders.controller.js';
import { FoldersService } from './folders.service.js';

/** 노트 탭의 학습 폴더 목록 · 만들기 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Folder.name, schema: FolderSchema },
      { name: Material.name, schema: MaterialSchema },
      { name: Subject.name, schema: SubjectSchema },
    ]),
    AuthModule,
  ],
  controllers: [FoldersController],
  providers: [FoldersService],
})
export class FoldersModule {}
