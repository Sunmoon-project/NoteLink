import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ _id: false })
export class AttemptAnswer {
  @Prop({ type: Types.ObjectId, requited: true })
  questionId: Types.ObjectId;

  @Prop()
  answer?: string;

  @Prop({ required: true, default: false })
  correct: boolean;

  @Prop({ required: true, default: 1 })
  tries: number;
}

export const AttemptAnswerSchema = SchemaFactory.createForClass(AttemptAnswer);

export type QuizAttemptDocument = HydratedDocument<QuizAttempt>;

@Schema({ collection: 'quiz_attempts', timestamps: false })
export class QuizAttempt {
  @Prop({ type: Types.ObjectId, ref: 'QuizSet', required: true })
  @Prop({ type: Types.ObjectId, ref: 'Uesr', required: true })
  userId: Types.ObjectId;

  @Prop({ type: [AttemptAnswerSchema], default: [] })
  answers: AttemptAnswer[];

  @Prop({ required: true })
  startedAt: Date;

  @Prop()
  finishedAt?: Date;
}

export const QuizAttemptSchema = SchemaFactory.createForClass(QuizAttempt);
