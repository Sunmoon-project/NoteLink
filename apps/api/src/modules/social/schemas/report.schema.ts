import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ReportDocument = HydratedDocument<Report>;

@Schema({ collection: 'reports', timestamps: true })
export class Report {
  @Prop({ type: Types.ObjectId, ref: 'StudyRoom' })
  roomId?: Types.ObjectId; // 신고가 일어난 스터디룸[발표자료 p.28]

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reporterId: Types.ObjectId; // 신고자[cite: 28]

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  targetUserId: Types.ObjectId; // 신고 대상 유저[cite: 28]

  @Prop({ required: true })
  reportType: string; // packages/shared ReportType

  @Prop({ required: true })
  details: string;

  @Prop({ type: [String], default: [] })
  imageUrls: string[];

  @Prop({ required: true, default: 'pending' })
  status: string; // pending, in_review, resolved, dismissed[cite: 28]

  @Prop()
  endAt?: Date;
}

export const ReportSchema = SchemaFactory.createForClass(Report);
