import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FlashcardDocument = HydratedDocument<Flashcard>;

@Schema({ collection: 'flashcards', timestamps: true })
export class Flashcard {
  @Prop({ type: Types.ObjectId, ref: 'Material' })
  materialId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  folderId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  ownerId: Types.ObjectId;

  @Prop({ required: true, type: String })
  front: string; // front(question)

  @Prop({ required: true, type: String })
  back: string; // back(answer)

  @Prop({ type: Types.ObjectId, required: true, ref: 'QuizSet' })
  sourceQuizSetId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  sourceQuestionId: Types.ObjectId;

  @Prop({ type: Object })
  srs?: Record<string, unknown> | null;

  @Prop({ type: String, default: null })
  lastResult?: string | null;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const FlashcardSchema = SchemaFactory.createForClass(Flashcard);
