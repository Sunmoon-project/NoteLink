import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 내장 문서: MaterialPage (공용 스키마 MaterialPage를 따름)
@Schema({ _id: false })
export class MaterialPage {
  @Prop({ required: true })
  pageNo: number;

  @Prop({ required: true })
  imageUrl: string;

  @Prop({ required: true })
  sizeBytes: number;

  @Prop({ default: null })
  ocrText?: string | null;

  @Prop({ default: null })
  takenAt?: Date | null;
}

export const MaterialPageSchema = SchemaFactory.createForClass(MaterialPage);

// 메인 스키마: materials (공용 스키마 Material을 따름)
export type MaterialDocument = HydratedDocument<Material>;

@Schema({ collection: 'materials', timestamps: true })
export class Material {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder', required: true })
  folderId: Types.ObjectId;

  @Prop({ required: true, enum: ['handwriting', 'recording', 'document'] })
  kind: string;

  @Prop({
    required: true,
    enum: ['camera', 'gallery', 'file', 'scan', 'live_recording', 'audio_file'],
  })
  source: string;

  @Prop({ required: true })
  title: string;

  @Prop({ default: null })
  description?: string | null;

  @Prop({ type: Types.ObjectId, ref: 'ShopItem', default: null })
  avatarItemId?: Types.ObjectId | null;

  @Prop({ type: [String], default: [] })
  keywords: string[];

  @Prop({ type: [MaterialPageSchema], default: [] })
  pages: MaterialPage[];

  @Prop({ default: null })
  deletedAt?: Date | null;
}

export const MaterialSchema = SchemaFactory.createForClass(Material);
