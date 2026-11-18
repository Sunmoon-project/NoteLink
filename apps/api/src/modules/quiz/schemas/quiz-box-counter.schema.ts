import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

// 퀴즈 보관함 담은 순서 번호를 나눠 주는 사용자별 카운터 (FR-57). 사람마다 한 건이고 _id가 사용자 id다.
// seq는 지금까지 나눠 준 마지막 번호다. 담을 때 새로 담을 개수만큼 한 번에 올려서(findOneAndUpdate $inc) 이어진 번호 묶음을 받는다.
// 담기가 도중에 실패해도 번호가 남을 뿐(빈 번호) 순서에는 영향이 없다
@Schema({ collection: 'quiz_box_counters', timestamps: false })
export class QuizBoxCounter {
    @Prop({ type: Types.ObjectId, ref: 'User', required: true })
    _id: Types.ObjectId;

    @Prop({ type: Number, required: true, default: 0 })
    seq: number;
}

export const QuizBoxCounterSchema = SchemaFactory.createForClass(QuizBoxCounter);
