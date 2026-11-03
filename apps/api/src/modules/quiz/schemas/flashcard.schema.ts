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

  @Prop({ required: true })
  front: string; // front(question)

  @Prop({ required: true })
  back: string; // back(answer)

  @Prop({ type: Types.ObjectId, ref: 'QuizSet' })
  sourceQuizSetId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Question' })
  sourceQuestionId: Types.ObjectId;

  @Prop({ type: Object })
  srs?: Record<string, any>;

  @Prop()
  lastResult?: string;

  @Prop()
  deletedAt?: Date;
}

export const FlashcardSchema = SchemaFactory.createForClass(Flashcard);
