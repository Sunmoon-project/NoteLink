import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PublicHolidayDocument = HydratedDocument<PublicHoliday>;

@Schema({ collection: 'public_holidays', timestamps: false })
export class PublicHoliday {
  @Prop({ required: true, type: String })
  _id: string; // YYYY-MM-DD 형태의 날짜를 문자열 _id로 직접 사용

  @Prop({ required: true, type: String })
  name: string; // 예: "개천절", "한글날"

  @Prop({ required: true, type: String })
  source: string; // public_api, manual 등

  @Prop({ required: true, type: Date, default: Date.now })
  createdAt: Date;
}

export const PublicHolidaySchema = SchemaFactory.createForClass(PublicHoliday);
