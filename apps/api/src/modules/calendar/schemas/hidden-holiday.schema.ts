import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

// 사용자가 캘린더에서 숨기기로 한 공휴일 (사용자 + 날짜 한 쌍이 한 건)
@Schema({ collection: 'hidden_holidays', timestamps: true })
export class HiddenHoliday {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    userId: Types.ObjectId; // users 참조

    @Prop({ type: String, required: true })
    date: string; // 'YYYY-MM-DD'
}

export const HiddenHolidaySchema = SchemaFactory.createForClass(HiddenHoliday);
HiddenHolidaySchema.index({ userId: 1, date: 1 }, { unique: true });
