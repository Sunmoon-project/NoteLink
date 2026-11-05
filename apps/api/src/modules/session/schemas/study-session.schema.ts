import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: Pause (일시정지 이력)
@Schema()
export class Pause {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: true, type: Date})
  startedAt: Date;

  @Prop({ type: Date, default: null })
  endedAt?: Date | null;

  @Prop({ type: String, default: null })
  reason?: string | null;
}
export const PauseSchema = SchemaFactory.createForClass(Pause);

// 메인 스키마: study_sessions
export type StudySessionDocument = HydratedDocument<StudySession>;

@Schema({ collection: 'study_sessions', timestamps: true })
export class StudySession {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId; // users 참조

  @Prop({ required: true, type: String })
  studyDate: string; // YYYY-MM-DD 형식

  @Prop({ type: Types.ObjectId, default: null })
  studyItemId?: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'StudyRoom', default: null })
  roomId?: Types.ObjectId | null; // study_rooms 참조

  // 공용 스키마 SessionMode: personal · room · auto_landscape
  @Prop({ required: true, type: String, enum: ['personal', 'room', 'auto_landscape'] })
  mode: string;

  // 공용 스키마: running · paused · ended
  @Prop({ required: true, type: String, enum: ['running', 'paused', 'ended'], default: 'running' })
  status: string;

  @Prop({ required: true, type: Date })
  startedAt: Date;

  @Prop({ type: Date, default: null })
  endedAt?: Date;

  @Prop({ required: true, type: Number, default: 0 })
  durationSec: number; // 실제 측정한 순공 시간(초)

  @Prop({ required: true, type: Number, default: 0 })
  departureCount: number; // 앱 이탈 횟수

  @Prop({ type: String, default: null })
  endReason?: string | null;

  @Prop({ required: true, type: Boolean, default: false })
  isAbuse: boolean; // 부정 측정 여부

  @Prop({ type: [PauseSchema], default: [] })
  pauses: Pause[]; // 일시정지 이력 배열
}

export const StudySessionSchema = SchemaFactory.createForClass(StudySession);
