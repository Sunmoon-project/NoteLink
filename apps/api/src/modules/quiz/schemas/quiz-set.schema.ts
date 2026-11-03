import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// Embedded document -> Question
@Schema()
export class Question {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId; // Individual issues ID

  @Prop({ required: true })
  type: string; // multiple_choice, short_answer

  @Prop({ required: true })
  prompt: string;

  @Prop({ type: [String], default: [] })
  choices?: string[];

  @Prop({ required: true })
  answer: string;

  @Prop()
  explanation?: string;

  @Prop()
  conceptTags?: string;

  @Prop({ type: Object })
  srs?: Record<string, any>;
}

export const QuestionSchema = SchemaFactory.createForClass(Question);

// main Schema: quiz_sets
export type QuizSetDocument = HydratedDocument<QuizSet>;

@Schema({ collection: 'quiz_sets', timestamps: true })
export class QuizSet {
  @Prop({ type: Types.ObjectId, ref: 'Material' })
  materialId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  folderId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ required: true })
  source: string; // ai_generated, manual

  @Prop({ type: Types.ObjectId, ref: 'QuizSet' })
  sourceSetId?: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true, default: 0 })
  total: number;

  @Prop({ required: true, default: 0 })
  correctCount: number;

  @Prop({ required: true, default: 0 })
  pointsEarned: number;

  @Prop({ required: true, default: 'ready' })
  status: number;

  @Prop({ required: true, default: 0 })
  progress: number;

  @Prop({ required: true, default: 0 })
  questionCount: number;

  @Prop({ type: [QuestionSchema], default: [] })
  questions: Question[];

  @Prop()
  deletedAt?: Date;
}

export const QuizSetSchema = SchemaFactory.createForClass(QuizSet);
