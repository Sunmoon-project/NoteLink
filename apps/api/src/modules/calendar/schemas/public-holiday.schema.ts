import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PublicHolidayDocument = HydratedDocument<PublicHoliday>;

@Schema({ collection: 'public_holidays', timestamps: false })
export class PublicHoliday {
  @Prop({ required: true })
  _id: string; // YYYY-MM-DD 형태의 날짜를 문자열 _id로 직접 사용[cite: 27]

  @Prop({ required: true })
  name: string; // 예: "개천절", "한글날"[cite: 27]

  @Prop({ required: true })
  source: string; // public_api, manual 등[cite: 27]

  @Prop({ required: true, default: Date.now })
  createdAt: Date;
}

export const PublicHolidaySchema = SchemaFactory.createForClass(PublicHoliday);
