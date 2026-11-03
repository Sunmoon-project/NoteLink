import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 메인 스키마: categories
// Subject(subjects) · Folder(folders)가 ref: 'Category'로 참조합니다.
export type CategoryDocument = HydratedDocument<Category>;

@Schema({ collection: 'categories', timestamps: true })
export class Category {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // users 참조

  @Prop({ required: true })
  name: string; // 예: 전공, 교양

  @Prop({ required: true, default: '#000000' })
  color: string; // 라벨 색상 코드

  @Prop({ required: true, default: 0 })
  sortOrder: number;

  @Prop({ required: true, default: true })
  isActive: boolean;

  @Prop()
  deletedAt?: Date;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
