import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: TimetableClass (개별 수업 교시)[cite: 27]
@Schema()
export class TimetableClass {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  subjectId?: Types.ObjectId; // subjects 참조[cite: 27]

  @Prop({ required: true })
  subjectName: string;

  @Prop({ type: [Number], required: true })
  days: number[]; // 수업 요일 배열 (0: 일요일, 1: 월요일 등)[cite: 27]

  @Prop({ required: true })
  startTime: string; // 예: "10:00"[cite: 27]

  @Prop({ required: true })
  endTime: string; // 예: "11:30"[cite: 27]

  @Prop()
  location?: string; // 강의실 위치[cite: 27]

  @Prop({ required: true, default: '#000000' })
  color: string;
}
export const TimetableClassSchema = SchemaFactory.createForClass(TimetableClass);

// 메인 스키마: timetables[cite: 27]
export type TimetableDocument = HydratedDocument<Timetable>;

@Schema({ collection: 'timetables', timestamps: true })
export class Timetable {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: [TimetableClassSchema], default: [] })
  classes: TimetableClass[]; // 내장된 수업 목록 배열[cite: 27]
}

export const TimetableSchema = SchemaFactory.createForClass(Timetable);
