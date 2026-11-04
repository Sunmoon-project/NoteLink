import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

import { REPORT_TYPES } from '../report.constants.js';

export type ReportDocument = HydratedDocument<Report>;

// reports (공용 스키마 packages/shared Report를 따름)
@Schema({ collection: 'reports', timestamps: true })
export class Report {
  @Prop({ type: Types.ObjectId, ref: 'StudyRoom', required: true })
  roomId: Types.ObjectId; // 신고가 일어난 스터디룸

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reporterId: Types.ObjectId; // 신고자

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  targetUserId: Types.ObjectId; // 신고 대상 유저

  @Prop({ required: true, enum: REPORT_TYPES })
  reportType: string;

  @Prop({ required: true })
  details: string;

  @Prop({ type: [String], default: [] })
  imageUrls: string[];

  @Prop({ required: true, default: 'pending' })
  status: string; // pending, in_review, resolved, dismissed

  @Prop({ default: null })
  endAt?: Date | null;
}

export const ReportSchema = SchemaFactory.createForClass(Report);
