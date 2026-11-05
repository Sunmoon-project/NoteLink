import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 내장 문서: MaterialPage (공용 스키마 MaterialPage를 따름)
@Schema({ _id: false })
export class MaterialPage {
  @Prop({ required: true, type: Number })
  pageNo: number;

  @Prop({ required: true, type: String })
  imageUrl: string;

  @Prop({ required: true, type: Number })
  sizeBytes: number;

  @Prop({ type: String, default: null })
  ocrText?: string | null;

  @Prop({ type: Date, default: null })
  takenAt?: Date | null;
}

export const MaterialPageSchema = SchemaFactory.createForClass(MaterialPage);

// 내장 문서: Processing (공용 스키마 Material.processing). AI 처리 진행 상태
@Schema({ _id: false })
export class Processing {
  @Prop({
    required: true,
    type: String,
    enum: ['uploading', 'queued', 'processing', 'done', 'failed'],
    default: 'uploading',
  })
  status: string;

  @Prop({ required: true, type: Number})
  progress: number;

  @Prop({ type: Types.ObjectId, ref: 'AiJob', default: null })
  jobId?: Types.ObjectId | null;
}

export const ProcessingSchema = SchemaFactory.createForClass(Processing);

// 내장 문서: SummarySection (요약의 소제목 + 본문)
@Schema({ _id: false })
export class SummarySection {
  @Prop({ required: true, type: String })
  heading: string;

  @Prop({ required: true, type: String })
  body: string;
}

export const SummarySectionSchema = SchemaFactory.createForClass(SummarySection);

// 내장 문서: Summary (공용 스키마 Material.summary). 요약 전에는 null
@Schema({ _id: false })
export class Summary {
  @Prop({ type: [SummarySectionSchema], default: [] })
  sections: SummarySection[];

  @Prop({ type: [String], default: [] })
  points: string[];
}

export const SummarySchema = SchemaFactory.createForClass(Summary);

// 내장 문서: Bookmark (녹음 북마크)
@Schema({ _id: false })
export class Bookmark {
  @Prop({ required: true, type: Number })
  atSec: number;

  @Prop({ type: String } ) // 예: "중간고사"
  label?: string;
}

export const BookmarkSchema = SchemaFactory.createForClass(Bookmark);

// 메인 스키마: materials (공용 스키마 Material을 따름)
export type MaterialDocument = HydratedDocument<Material>;

@Schema({ collection: 'materials', timestamps: true })
export class Material {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder', required: true })
  folderId: Types.ObjectId;

  @Prop({ required: true, 
    type: String, 
    enum: ['handwriting', 'recording', 'document'] 
  })
  kind: string;

  @Prop({
    required: true,
    type: String,
    enum: ['camera', 'gallery', 'file', 'scan', 'live_recording', 'audio_file'],
  })
  source: string;

  @Prop({ required: true, type: String })
  title: string;

  @Prop({ type: String, default: null })
  description?: string | null;

  @Prop({ type: Types.ObjectId, ref: 'ShopItem', default: null })
  avatarItemId?: Types.ObjectId | null;

  @Prop({ type: ProcessingSchema, required: true, default: () => ({}) })
  processing: Processing;

  @Prop({ type: SummarySchema, default: null })
  summary?: Summary | null;

  @Prop({ type: [String], default: [] })
  keywords: string[];

  @Prop({ type: [BookmarkSchema], default: [] })
  bookmarks: Bookmark[];

  @Prop({ type: [MaterialPageSchema], default: [] })
  pages: MaterialPage[];

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const MaterialSchema = SchemaFactory.createForClass(Material);
