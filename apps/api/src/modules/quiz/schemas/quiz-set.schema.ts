import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 내장 문서: Question (공용 스키마 Question을 따름)
@Schema()
export class Question {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: true, type: Number, default: 0 })
  order: number;

  @Prop({ required: true, type: String, enum: ['multiple_choice', 'short_answer', 'ox'] })
  type: string;

  @Prop({ required: true, type: String })
  prompt: string;

  // 객관식이 아니면 null
  @Prop({ type: [String], default: null })
  choices?: string[] | null;

  @Prop({ required: true })
  answer: string;

  @Prop({ type: String, default: null })
  explanation?: string | null;

  @Prop({ type: [String], default: [] })
  conceptTags: string[];

  // 복습 상태(step · dueAt · lastResult · streak · reviews · state 등). 형식은 처리기(apps/ai srs.py)가 정하고,
  // 오답 복습(similar_quiz)의 srsUpdates를 NestJS가 여기에 반영한다. 공용 스키마에는 아직 없다.
  @Prop({ type: Object, default: null })
  srs?: Record<string, unknown> | null;
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

  @Prop({ required: true, type: String, enum: ['ai_generated', 'manual'] })
  source: string;

  @Prop({ type: Types.ObjectId, ref: 'QuizSet', default: null })
  sourceSetId?: Types.ObjectId | null;

  @Prop({ required: true, type: String })
  title: string;

  // 공용 스키마의 status는 'generating' | 'ready' | 'failed' 문자열이다.
  @Prop({ required: true, type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' })
  status: string;

  @Prop({ required: true, type: Number, default: 0 })
  progress: number;

  @Prop({ required: true, type: Number,default: 0 })
  questionCount: number;

  @Prop({ type: [QuestionSchema], default: [] })
  questions: Question[];

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const QuizSetSchema = SchemaFactory.createForClass(QuizSet);
