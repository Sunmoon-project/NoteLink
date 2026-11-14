import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

// 퀴즈 보관함에 담은 문제 한 건 (FR-57). 문제 내용은 복사하지 않고 quiz_sets 안의 문제를 가리키기만 한다
// (정답 · 설명이 바뀌어도 보관함에는 항상 최신이 보인다). 사람 + 문제 한 쌍이 한 건이다
@Schema({ collection: 'quiz_box_items', timestamps: false })
export class QuizBoxItem {
    @Prop({ type: Types.ObjectId, ref: 'User', required: true })
    userId: Types.ObjectId; // 보관함 주인

    @Prop({ type: Types.ObjectId, required: true })
    questionId: Types.ObjectId; // quiz_sets.questions._id

    @Prop({ type: Types.ObjectId, ref: 'QuizSet', required: true })
    quizSetId: Types.ObjectId; // 문제가 들어 있는 세트

    @Prop({ type: Date, required: true })
    savedAt: Date; // 실제로 담은 시각 (보여 주기만 하고, 정렬에는 쓰지 않는다)

    // 담은 순서 번호: 사용자별 카운터(quiz_box_counters)에서 한 요청이 필요한 만큼 한 번에 받는다.
    // 요청 하나의 문제는 이어진 번호를 받아 다른 요청과 섞이지 않는다. 번호가 없는 옛 문서는 savedAt 순으로 맨 앞에 온다
    @Prop({ type: Number, required: false })
    order?: number;
}

export const QuizBoxItemSchema = SchemaFactory.createForClass(QuizBoxItem);

// 같은 문제를 두 번 (동시에도) 담아도 한 건만 남게
QuizBoxItemSchema.index({ userId: 1, questionId: 1 }, { unique: true });
// 내 보관함 목록 (담은 순서: order, 번호가 없는 옛 문서는 savedAt)
QuizBoxItemSchema.index({ userId: 1, order: 1 });
