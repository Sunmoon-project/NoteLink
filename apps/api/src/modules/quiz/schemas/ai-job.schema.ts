import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AiJobDocument = HydratedDocument<AiJob>;

// ai_jobs: NestJS가 작업을 넣고, FastAPI 처리기가 꺼내 처리한 뒤 결과를 같은 문서에 씁니다.
// 상태·필드 이름은 공용 스키마(packages/shared AiJob)와 처리기(apps/ai jobs.py)를 따릅니다.
@Schema({ collection: 'ai_jobs', timestamps: true })
export class AiJob {
  @Prop({
    required: true,
    enum: [
      'handwriting_summary',
      'recording_summary',
      'document_summary',
      'quiz_generate',
      'similar_quiz',
      'explain',
      'avatar_profile',
      'image_check',
    ],
  })
  type: string;

  @Prop({
    required: true,
    enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
    default: 'queued',
  })
  status: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  targetType: string;

  @Prop({ type: Types.ObjectId, required: true })
  targetId: Types.ObjectId;

  // 처리에 필요한 자료를 NestJS가 넣는다(처리기는 다른 컬렉션을 읽지 않음).
  @Prop({ type: Object, required: true })
  input: Record<string, unknown>;

  // 처리기가 쓴 결과를 NestJS가 읽어 quiz_sets 등에 반영한다.
  @Prop({ type: Object, default: null })
  result?: Record<string, unknown> | null;

  @Prop({ required: true, default: 0 })
  progress: number;

  @Prop({ required: true, default: 0 })
  attempts: number;

  // 공용 스키마에서 '없거나 문자열'. 처리기는 None 대신 필드를 지운다.
  @Prop()
  step?: string;

  @Prop({ default: null })
  error?: string | null;

  // 잠금(처리기가 관리)
  @Prop({ default: null })
  lockedBy?: string | null;

  @Prop({ default: null })
  lockedUntil?: Date | null;

  @Prop({ default: null })
  retryAt?: Date | null;
}

export const AiJobSchema = SchemaFactory.createForClass(AiJob);
