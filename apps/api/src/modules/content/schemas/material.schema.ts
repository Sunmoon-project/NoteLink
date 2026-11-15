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

  @Prop({ required: true, type: Number })
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

  @Prop({ type: String }) // 예: "중간고사"
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

  @Prop({ required: true, type: String, enum: ['handwriting', 'recording', 'document'] })
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

  /**
   * 퀴즈 처리기가 뽑은 개념 이름(apps/ai services/quiz/generate.py 결과 concepts). 다음 퀴즈 입력에 넣어
   * 처리기가 개념을 다시 뽑지 않게 한다(#134 · #274). 앱 계약(packages/shared Material)에는 없는 서버 값.
   * 노트 글을 고치는 곳(노트 API)이 생기면 그때 비운다
   */
  @Prop({ type: [String], default: [] })
  concepts: string[];

  @Prop({ type: [BookmarkSchema], default: [] })
  bookmarks: Bookmark[];

  @Prop({ type: [MaterialPageSchema], default: [] })
  pages: MaterialPage[];

  /** 앱이 올린 원본 파일 주소(SAS 없는 blob 주소, 올린 순서). 앱 계약(Material)에는 없는 서버 값 */
  @Prop({ type: [String], default: [] })
  blobUrls: string[];

  /** 앱의 "저장" 버튼을 누른 시각. 앱 계약(Material)에는 없는 서버 값 */
  @Prop({ type: Date, default: null })
  savedAt?: Date | null;

  /** 등록 요청의 Idempotency-Key. 같은 키의 재요청이 같은 자료를 돌려받게 한다. 키 없이 만든 자료는 없다 */
  @Prop({ type: String })
  requestId?: string;

  /** 등록 본문의 해시. 같은 키에 다른 내용을 보냈는지 가린다 */
  @Prop({ type: String })
  requestFingerprint?: string;

  /**
   * 정리 작업을 만드는 요청이 잡은 표시(작업 id 가 연결되면 지운다). 같은 노트에 요청이 겹쳐도 작업을 만드는 쪽을
   * 하나로 하려는 서버 값이라 앱에는 보내지 않는다. 서버가 멈춰 남은 표시는 jobClaimedAt 으로부터 시간이 지나면 무효다
   */
  @Prop({ type: String })
  jobClaimToken?: string;

  @Prop({ type: Date })
  jobClaimedAt?: Date;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const MaterialSchema = SchemaFactory.createForClass(Material);

// 폴더별 자료 수 세기 · 폴더 안 자료 찾기(내 것, 지우지 않은 것)
MaterialSchema.index({ ownerId: 1, deletedAt: 1, folderId: 1 });
// 같은 사용자의 같은 Idempotency-Key는 자료 하나(키 없이 만든 자료는 제외)
MaterialSchema.index(
  { ownerId: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } },
);
