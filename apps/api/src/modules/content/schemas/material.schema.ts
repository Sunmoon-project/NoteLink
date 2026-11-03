import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ _id: false })
export class MaterialPage {
  @Prop({ required: true })
  pageNo: number;

  @Prop({ required: true })
  imageUrl: string;

  @Prop({ required: true })
  sizeByte: number; // long type -> number

  @Prop()
  takenAt?: Date;

  @Prop()
  ocrText?: string;
}

export const MaterialPageSchema = SchemaFactory.createForClass(MaterialPage);

// main schema: materials
export type MaterialDocument = HydratedDocument<Material>;

@Schema({ collection: 'materials', timestamps: true })
export class Material {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  folderId?: Types.ObjectId;

  @Prop({ required: true })
  kind: string;

  @Prop({ required: true })
  title: string;

  @Prop()
  description?: string;

  @Prop({ required: true, default: 0 })
  progress: number;

  @Prop({ required: true, default: 0 })
  attempts: number;

  @Prop({ type: [MaterialPageSchema], default: [] })
  pages: MaterialPage[];

  @Prop()
  deletedAt?: Date;
}

export const MaterialSchema = SchemaFactory.createForClass(Material);
