import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: Pause (일시정지 이력)[cite: 26]
@Schema()
export class Pause {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: true })
  startedAt: Date;

  @Prop()
  endedAt?: Date;

  @Prop()
  reason?: string;
}
export const PauseSchema = SchemaFactory.createForClass(Pause);

// 메인 스키마: study_sessions[cite: 26]
export type StudySessionDocument = HydratedDocument<StudySession>;

@Schema({ collection: 'study_sessions', timestamps: true })
export class StudySession {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId; // users 참조[cite: 26]

  @Prop({ required: true })
  studyDate: string; // YYYY-MM-DD 형식[cite: 26]

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  studyItemId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'StudyRoom' })
  roomId?: Types.ObjectId; // study_rooms 참조[cite: 26]

  @Prop({ required: true })
  mode: string; // timer, stopwatch 등[cite: 26]

  @Prop({ required: true, default: 'active' })
  status: string; // active, paused, finished[cite: 26]

  @Prop({ required: true })
  startedAt: Date;

  @Prop()
  endedAt?: Date;

  @Prop({ required: true, default: 0 })
  durationSec: number; // 실제 측정한 순공 시간(초)[cite: 26]

  @Prop({ required: true, default: 0 })
  departureCount: number; // 앱 이탈 횟수[cite: 26]

  @Prop()
  endReason?: string;

  @Prop({ required: true, default: false })
  isAbuse: boolean; // 부정 측정 여부[cite: 26]

  @Prop({ type: [PauseSchema], default: [] })
  pauses: Pause[]; // 일시정지 이력 배열[cite: 26]
}

export const StudySessionSchema = SchemaFactory.createForClass(StudySession);
