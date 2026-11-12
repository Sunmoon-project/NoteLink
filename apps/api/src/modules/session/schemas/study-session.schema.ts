import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, type HydratedDocument } from 'mongoose';

export const SESSION_MODES = ['personal', 'room', 'auto_landscape'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_STATUSES = ['running', 'paused', 'ended'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

// 일시정지 한 번 (공유 계약 StudySession.pauses의 한 칸). 끝나지 않았으면 endedAt이 null
@Schema({ _id: false })
export class SessionPause {
    @Prop({ type: Date, required: true })
    startedAt: Date;

    @Prop({ type: Date, default: null })
    endedAt: Date | null;

    @Prop({ type: String, default: null })
    reason: string | null;
}
export const SessionPauseSchema = SchemaFactory.createForClass(SessionPause);

export type StudySessionDocument = HydratedDocument<StudySession>;

// 공부 타이머 한 번의 기록. 시간과 포인트는 서버가 시작·일시정지 시각으로 계산한다
@Schema({ collection: 'study_sessions', timestamps: true })
export class StudySession {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    userId: Types.ObjectId; // users 참조

    @Prop({ type: String, required: true })
    studyDate: string; // 시작한 날 (서울 기준 'YYYY-MM-DD')

    @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
    studyItemId: Types.ObjectId | null; // 그날 daily_records.items 안의 항목 _id

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'StudyRoom', default: null })
    roomId: Types.ObjectId | null;

    @Prop({ type: String, required: true, enum: SESSION_MODES })
    mode: SessionMode;

    @Prop({ type: String, required: true, enum: SESSION_STATUSES, default: 'running' })
    status: SessionStatus;

    @Prop({ type: Date, required: true })
    startedAt: Date;

    @Prop({ type: Date, default: null })
    endedAt: Date | null;

    @Prop({ required: true, default: 0, min: 0 })
    durationSec: number; // 끝났을 때 서버가 계산해서 채운다

    @Prop({ required: true, default: 0, min: 0 })
    departureCount: number;

    @Prop({ type: String, default: null })
    endReason: string | null;

    @Prop({ required: true, default: false })
    isAbuse: boolean;

    @Prop({ required: true, default: 0, min: 0 })
    pointsEarned: number; // 끝날 때 적립한 포인트 (같은 세션을 다시 끝내도 이 값을 그대로 돌려준다)

    @Prop({ type: [SessionPauseSchema], default: [] })
    pauses: SessionPause[];
}

export const StudySessionSchema = SchemaFactory.createForClass(StudySession);

// "내 세션을 날짜별로" 찾는 조회가 많다
StudySessionSchema.index({ userId: 1, studyDate: 1 });

// 새 세션을 시작할 때 "이 사람의 열려 있는 세션"을 찾는다
StudySessionSchema.index({ userId: 1, status: 1 });

// 사용자당 열린 세션(running·paused)은 하나. 동시 시작 중복을 DB가 막는다
StudySessionSchema.index(
    { userId: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ['running', 'paused'] } } },
);
