import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, type HydratedDocument } from 'mongoose';

// 그날 공부할 항목 하나 (공유 계약 StudyItem). _id는 Mongoose가 자동으로 만든다
@Schema()
export class StudyItem {
    @Prop({ required: true })
    title: string;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Subject', default: null })
    subjectId: Types.ObjectId | null;

    @Prop({ type: String, default: null })
    subjectName: string | null;

    @Prop({ type: Number, default: null })
    goalMin: number | null;

    @Prop({ required: true, default: 0, min: 0 })
    accumulatedSec: number; // 그날 이 항목에 쌓인 공부 시간
}
export const StudyItemSchema = SchemaFactory.createForClass(StudyItem);

export type DailyRecordDocument = HydratedDocument<DailyRecord>;

// 하루치 공부 기록 (사용자 한 명 · 날짜 하나당 한 건). 그날의 공부 항목이 안에 들어 있다
@Schema({ collection: 'daily_records', timestamps: true })
export class DailyRecord {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    userId: Types.ObjectId; // users 참조

    @Prop({ type: String, required: true })
    studyDate: string; // 서울 기준 'YYYY-MM-DD'

    @Prop({ required: true, default: 0, min: 0 })
    totalSec: number;

    @Prop({ required: true, default: 0, min: 0 })
    personalSec: number;

    @Prop({ required: true, default: 0, min: 0 })
    roomSec: number;

    @Prop({ required: true, default: false })
    streakOk: boolean; // 연속 달성 여부. 판정 규칙은 통계(progress) 단계에서 정한다

    @Prop({ type: [StudyItemSchema], default: [] })
    items: StudyItem[];

    // 그날 과목별로 쌓인 공부 시간(초). 키는 과목 id 글자. 자정을 넘긴 공부는 다음 날 몫도 여기 쌓인다
    // (items.accumulatedSec은 시작한 날에만 쌓여서 다음 날 과목 시간을 알 수 없다). 반복 목표 판정에만 쓰고 앱에는 내보내지 않는다.
    // 이 칸이 생기기 전의 옛 기록에는 없다(그때는 items에서 읽는다). 기본값은 두지 않는다 — 과목 없는 날은 칸 자체가 없다
    @Prop({ type: Map, of: Number })
    subjectSec?: Record<string, number>;
}

export const DailyRecordSchema = SchemaFactory.createForClass(DailyRecord);

// 한 사람이 같은 날짜 기록을 두 개 가질 수 없게 (오늘 기록을 동시에 만들려 해도 한 건만)
DailyRecordSchema.index({ userId: 1, studyDate: 1 }, { unique: true });
