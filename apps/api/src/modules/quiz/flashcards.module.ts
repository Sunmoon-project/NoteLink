import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { Material, MaterialSchema } from '../content/schemas/material.schema.js';
import { FlashcardsController } from './flashcards.controller.js';
import { FlashcardsService } from './flashcards.service.js';
import { Flashcard, FlashcardSchema } from './schemas/flashcard.schema.js';
import { QuizSet, QuizSetSchema } from './schemas/quiz-set.schema.js';

/** 플래시카드 저장 · 조회 · 삭제(FR-55 · 56) */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Flashcard.name, schema: FlashcardSchema },
      { name: QuizSet.name, schema: QuizSetSchema }, // 내 세트의 문제인지 읽기만 한다
      { name: Material.name, schema: MaterialSchema }, // 세트에 폴더가 없을 때 자료의 폴더를 읽기만 한다
    ]),
    AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
  ],
  controllers: [FlashcardsController],
  providers: [FlashcardsService],
})
export class FlashcardsModule {}
