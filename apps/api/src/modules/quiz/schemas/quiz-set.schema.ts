import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 내장 문서: Question (공용 스키마 Question을 따름)
@Schema()
export class Question {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: true, default: 0 })
  order: number;

  @Prop({ required: true, enum: ['multiple_choice', 'short_answer', 'ox'] })
  type: string;

  @Prop({ required: true })
  prompt: string;

  // 객관식이 아니면 null
  @Prop({ type: [String], default: null })
  choices?: string[] | null;

  @Prop({ required: true })
  answer: string;

  @Prop({ default: null })
  explanation?: string | null;

  @Prop({ type: [String], default: [] })
  conceptTags: string[];
}

export const QuestionSchema = SchemaFactory.createForClass(Question);

// 메인 스키마: quiz_sets (공용 스키마 QuizSet을 따름)
export type QuizSetDocument = HydratedDocument<QuizSet>;

@Schema({ collection: 'quiz_sets', timestamps: true })
export class QuizSet {
  @Prop({ type: Types.ObjectId, ref: 'Material' })
  materialId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  folderId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ required: true, enum: ['ai_generated', 'manual'] })
  source: string;

  @Prop({ type: Types.ObjectId, ref: 'QuizSet', default: null })
  sourceSetId?: Types.ObjectId | null;

  @Prop({ required: true })
  title: string;

  // 공용 스키마의 status는 'generating' | 'ready' | 'failed' 문자열이다.
  @Prop({ required: true, enum: ['generating', 'ready', 'failed'], default: 'generating' })
  status: string;

  @Prop({ required: true, default: 0 })
  progress: number;

  @Prop({ required: true, default: 0 })
  questionCount: number;

  @Prop({ type: [QuestionSchema], default: [] })
  questions: Question[];

  @Prop({ default: null })
  deletedAt?: Date | null;
}

export const QuizSetSchema = SchemaFactory.createForClass(QuizSet);
