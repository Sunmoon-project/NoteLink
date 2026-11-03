import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: StudyItem (오늘 할 항목)[cite: 26]
@Schema()
export class StudyItem {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: true })
  title: string; // 예: 이차방정식 풀이[cite: 26]

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  subjectId?: Types.ObjectId;

  @Prop()
  goalMin?: number;

  @Prop({ required: true, default: 0 })
  accumulatedSec: number; // 누적 측정 시간(초)
}
export const StudyItemSchema = SchemaFactory.createForClass(StudyItem);

// 메인 스키마: daily_records[cite: 26]
export type DailyRecordDocument = HydratedDocument<DailyRecord>;

@Schema({ collection: 'daily_records', timestamps: true })
export class DailyRecord {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  studyDate: string; // YYYY-MM-DD

  @Prop({ required: true, default: 0 })
  totalSec: number; // 오늘 총 순공 시간

  @Prop({ required: true, default: 0 })
  personalSec: number; // 개인 공부 시간

  @Prop({ required: true, default: 0 })
  roomSec: number; // 스터디룸 공부 시간

  @Prop({ required: true, default: false })
  streakOk: boolean; // 스트릭(연속 공부) 달성 여부

  @Prop({ type: [StudyItemSchema], default: [] })
  items: StudyItem[]; // 항목별 공부 목록
}

export const DailyRecordSchema = SchemaFactory.createForClass(DailyRecord);
