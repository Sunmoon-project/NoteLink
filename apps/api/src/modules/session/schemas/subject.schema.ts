import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type SubjectDocument = HydratedDocument<Subject>;

@Schema({ collection: 'subjects', timestamps: true })
export class Subject {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // users 참조[cite: 26]

  @Prop({ type: Types.ObjectId, ref: 'Category' })
  categoryId?: Types.ObjectId; // categories 참조[cite: 26]

  @Prop({ required: true })
  name: string; // 예: 수학, 영어[cite: 26]

  @Prop({ required: true, default: '#000000' })
  color: string; // 라벨 색상 코드[cite: 26]

  @Prop({ required: true, default: 0 })
  sortOrder: number;

  @Prop({ required: true, default: true })
  isActive: boolean;
}

export const SubjectSchema = SchemaFactory.createForClass(Subject);
