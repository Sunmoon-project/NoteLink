import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

// 사용자가 직접 정한 제외일(여행·방학 등). 지금은 하루짜리이고, 범위가 필요해지면 endDate를 더한다.
@Schema({ collection: 'custom_holidays', timestamps: true })
export class CustomHoliday {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    userId: Types.ObjectId; // users 참조

    @Prop({ type: String, required: true })
    name: string;

    @Prop({ type: String, required: true })
    date: string; // 'YYYY-MM-DD'
}

export const CustomHolidaySchema = SchemaFactory.createForClass(CustomHoliday);
CustomHolidaySchema.index({ userId: 1, date: 1 });
