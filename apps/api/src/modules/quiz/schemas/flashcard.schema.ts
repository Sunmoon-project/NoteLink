import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FlashcardDocument = HydratedDocument<Flashcard>;

@Schema({ collection: 'flashcards', timestamps: true })
export class Flashcard {
  // 문제에서 저장한 카드가 아니면 null(공용 스키마 Flashcard.materialId는 nullable)
  @Prop({ type: Types.ObjectId, ref: 'Material', default: null })
  materialId?: Types.ObjectId | null;

  // 폴더를 정할 수 없으면 null(문제 없이 저장한 카드). 폴더 API가 생기면 그때 채운다
  @Prop({ type: Types.ObjectId, ref: 'Folder', default: null })
  folderId?: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  ownerId: Types.ObjectId;

  @Prop({ required: true, type: String })
  front: string; // front(question)

  @Prop({ required: true, type: String })
  back: string; // back(answer)

  // 공용 스키마와 앱은 null을 허용한다(문제 없이 직접 만든 카드). required를 풀고 기본값을 null로 둔다
  @Prop({ type: Types.ObjectId, ref: 'QuizSet', default: null })
  sourceQuizSetId?: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, default: null })
  sourceQuestionId?: Types.ObjectId | null;

  @Prop({ type: Object })
  srs?: Record<string, unknown> | null;

  @Prop({ type: String, default: null })
  lastResult?: string | null;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const FlashcardSchema = SchemaFactory.createForClass(Flashcard);

// 내 카드 목록(지우지 않은 것, 만든 순)
FlashcardSchema.index({ ownerId: 1, deletedAt: 1, createdAt: 1 });
