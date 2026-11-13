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
    savedAt: Date; // 담은 시각 (한 번에 여러 개를 담으면 보낸 순서대로 1ms씩 차이를 둔다)
}

export const QuizBoxItemSchema = SchemaFactory.createForClass(QuizBoxItem);

// 같은 문제를 두 번 (동시에도) 담아도 한 건만 남게
QuizBoxItemSchema.index({ userId: 1, questionId: 1 }, { unique: true });
// 내 보관함 목록 (담은 순서)
QuizBoxItemSchema.index({ userId: 1, savedAt: 1 });
