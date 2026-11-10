import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: TimetableClass (개별 수업 교시)
@Schema()
export class TimetableClass {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  subjectId?: Types.ObjectId; // subjects 참조

  @Prop({ required: true, type: String })
  subjectName: string;

  @Prop({ type: [Number], required: true })
  days: number[]; // 수업 요일 배열 (0: 일요일, 1: 월요일 등)

  @Prop({ required: true, type: String })
  startTime: string; // 예: "10:00"

  @Prop({ required: true, type: String })
  endTime: string; // 예: "11:30"

  @Prop({ type: String, default: null })
  location?: string; // 강의실 위치

  @Prop({ required: true, type: String, default: '#000000' }) // hex color code
  color: string;

  @Prop({ type: String, required: true, default: 'manual' })
  source: string; // 수업 출처 (직접 추가는 'manual')
}
export const TimetableClassSchema = SchemaFactory.createForClass(TimetableClass);

// 메인 스키마: timetables
export type TimetableDocument = HydratedDocument<Timetable>;

@Schema({ collection: 'timetables', timestamps: true })
export class Timetable {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId; // 사용자 한 명당 시간표 한 건

  @Prop({ type: [TimetableClassSchema], default: [] })
  classes: TimetableClass[]; // 내장된 수업 목록 배열
}

export const TimetableSchema = SchemaFactory.createForClass(Timetable);
