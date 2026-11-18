import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, type HydratedDocument } from 'mongoose';

export const POINT_REASON_TYPES = [
    'session_complete',
    'quiz_correct',
    'review_complete',
    'session_abuse',
    'purchase',
    'mission',
    'admin',
] as const;
export type PointReasonType = (typeof POINT_REASON_TYPES)[number];

export type PointLedgerDocument = HydratedDocument<PointLedger>;

// 포인트가 늘거나 줄 때마다 한 줄씩 쌓는 장부 (수정·삭제 없이 쌓기만 한다)
// amount가 양수면 적립(earn), 음수면 사용(spend)
@Schema({ collection: 'point_ledgers', timestamps: true })
export class PointLedger {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    userId: Types.ObjectId; // users 참조

    @Prop({ type: Number, required: true })
    amount: number;

    @Prop({ type: Number, required: true })
    balanceAfter: number; // 이 내역이 반영된 뒤의 잔액

    @Prop({ type: String, required: true, enum: POINT_REASON_TYPES })
    reasonType: PointReasonType;

    // 어떤 일로 생긴 내역인지 가리키는 선택 참조 (구매 · 퀴즈 · 공부 세션)
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'ShopItem' })
    itemId?: Types.ObjectId;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'QuizAttempt' })
    attemptId?: Types.ObjectId;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'StudySession' })
    sessionId?: Types.ObjectId;

    @Prop({ type: String, default: null })
    studyDate?: string | null; // 서울 기준 'YYYY-MM-DD' (하루 적립 한도 계산용)

    @Prop({ type: String, default: null })
    description: string | null;
}

export const PointLedgerSchema = SchemaFactory.createForClass(PointLedger);

// "내 내역을 최신순으로" 가 가장 흔한 조회라서 이 순서로 인덱스를 만든다
PointLedgerSchema.index({ userId: 1, _id: -1 });