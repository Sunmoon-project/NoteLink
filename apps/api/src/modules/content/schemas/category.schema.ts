import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 메인 스키마: categories
// Subject(subjects) · Folder(folders)가 ref: 'Category'로 참조합니다.
export type CategoryDocument = HydratedDocument<Category>;

@Schema({ collection: 'categories', timestamps: true })
export class Category {
  // 공용 스키마 Category에는 소유자가 없다. 기본 카테고리는 ownerId 없이 모두가 쓴다.
  @Prop({ type: Types.ObjectId, ref: 'User' })
  ownerId?: Types.ObjectId; // users 참조

  // 상위 카테고리. 최상위는 null
  @Prop({ type: Types.ObjectId, ref: 'Category', default: null })
  parentId?: Types.ObjectId | null;

  @Prop({ required: true, type: String })
  name: string; // 예: 전공, 교양

  @Prop({ required: true, type: String, default: '#000000' })
  color: string; // 라벨 색상 코드

  @Prop({ required: true, type: Number, default: 0 })
  sortOrder: number;

  @Prop({ required: true, type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Date, default: null })
  deletedAt?: Date;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
