import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 내장 문서: AttemptAnswer (공용 스키마 AttemptAnswer를 따름)
@Schema({ _id: false })
export class AttemptAnswer {
  @Prop({ type: Types.ObjectId, required: true })
  questionId: Types.ObjectId;

  @Prop({ type: String, default: null })
  answer?: string | null;

  @Prop({ required: true, type: Boolean, default: false })
  correct: boolean;

  @Prop({ required: true, type: Number, default: 1 })
  tries: number;
}

export const AttemptAnswerSchema = SchemaFactory.createForClass(AttemptAnswer);

// 메인 스키마: quiz_attempts (공용 스키마 QuizAttempt를 따름)
export type QuizAttemptDocument = HydratedDocument<QuizAttempt>;

@Schema({ collection: 'quiz_attempts', timestamps: false })
export class QuizAttempt {
  @Prop({ type: Types.ObjectId, ref: 'QuizSet', required: true })
  quizSetId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: Number, default: 0 })
  correctCount: number;

  @Prop({ required: true, type: Number, default: 0 })
  total: number;

  @Prop({ required: true, type: Number, default: 0 })
  pointsEarned: number;

  @Prop({ type: [AttemptAnswerSchema], default: [] })
  answers: AttemptAnswer[];

  @Prop({ required: true, type: Date })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  finishedAt?: Date | null;
}

export const QuizAttemptSchema = SchemaFactory.createForClass(QuizAttempt);
// 퀴즈를 만들 때 처리기 입력에 넣는 내 끝낸 풀이(최근 것부터, QuizSetsService.generateInput)
QuizAttemptSchema.index({ userId: 1, finishedAt: -1 });
// 전체 사용자의 완료된 풀이만 유형별 통계에 집계한다(QuizSetsService.readTypeStats, #268).
QuizAttemptSchema.index(
  { finishedAt: 1 },
  { partialFilterExpression: { finishedAt: { $type: 'date' } } },
);
