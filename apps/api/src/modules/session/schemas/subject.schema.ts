import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SubjectDocument = HydratedDocument<Subject>;

@Schema({ collection: 'subjects', timestamps: true })
export class Subject {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // users 참조

  @Prop({ type: Types.ObjectId, ref: 'Category' })
  categoryId?: Types.ObjectId; // categories 참조

  @Prop({ required: true, type: String })
  name: string; // 예: 수학, 영어

  @Prop({ required: true, type: String, default: '#000000' }) 
  color: string; // 라벨 색상 코드

  @Prop({ required: true, type: Number, default: 0 })
  sortOrder: number;

  @Prop({ required: true, type: Boolean, default: true })
  isActive: boolean;
}

export const SubjectSchema = SchemaFactory.createForClass(Subject);
