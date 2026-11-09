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
      'quiz_pregen',
      'similar_quiz',
      'today_review',
      'explain',
      'avatar_profile',
      'image_check',
    ],
    type: String,
  })
  type: string;

  @Prop({
    required: true,
    type: String,
    enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'],
    default: 'queued',
  })
  status: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String })
  targetType: string;

  // 가리키는 문서는 targetType에 따라 다르다(quiz_set · material · user 등)
  @Prop({ type: Types.ObjectId, required: true })
  targetId: Types.ObjectId;

  // 처리에 필요한 자료를 NestJS가 넣는다(처리기는 다른 컬렉션을 읽지 않음).
  @Prop({ type: Object, required: true })
  input: Record<string, unknown>;

  // 처리기가 쓴 결과를 NestJS가 읽어 quiz_sets 등에 반영한다.
  @Prop({ type: Object, default: null })
  result?: Record<string, unknown> | null;

  @Prop({ type: Number, default: 0 }) // 0 ~ 100%
  progress: number;

  // 미리 해 두는 작업(quiz_pregen)이 끝나기 전에 사용자가 퀴즈를 요청하면, 새 작업을 넣지 않고
  // 이 값을 true로 바꾼다. 처리기가 사용자 작업처럼 먼저 처리한다(apps/ai jobs.py).
  @Prop({ type: Boolean, default: false })
  awaited?: boolean;

  // 처리기가 가져갈 때마다 1 늘린다. 앱의 '다시 시도'는 NestJS가 0으로 되돌린다
  @Prop({ required: true, type: Number, default: 0 })
  attempts: number;

  // 공용 스키마에서 '없거나 문자열'. 처리기는 None 대신 필드를 지운다.
  @Prop({ type: String })
  step?: string;

  @Prop({ type: String })
  error?: string; // 예: "ValueError: 잘못된 입력"

  // 잠금(처리기가 관리)
  @Prop({ type: String })
  lockedBy?: string; // 예: "job_123"

  @Prop({ type: Date, default: null })
  lockedUntil?: Date | null; // 예: "2026-01-01 12:00:00" 이후 잠금 해제

  @Prop({ type: Date, default: null })
  retryAt?: Date | null; // 예: "2026-01-01 12:00:00" 이후 재시도
}

export const AiJobSchema = SchemaFactory.createForClass(AiJob);

// 처리기가 상태 · 종류별로 가장 먼저 들어온 작업을 가져간다(apps/ai jobs.py)
AiJobSchema.index({ status: 1, type: 1, createdAt: 1 });
// 같은 노트의 끝나지 않은 미리 만들기 찾기(AiJobsService.takeOverPregen)
AiJobSchema.index({ userId: 1, type: 1, targetType: 1, targetId: 1, status: 1, createdAt: -1 });
