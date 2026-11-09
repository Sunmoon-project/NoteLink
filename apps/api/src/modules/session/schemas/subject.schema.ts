import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types, type HydratedDocument } from 'mongoose';

export type SubjectDocument = HydratedDocument<Subject>;

// 과목 목록 (모든 사용자 공통). 공부 항목을 만들 때 고른다
@Schema({ collection: 'subjects', timestamps: true })
export class Subject {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Category', default: null })
    categoryId: Types.ObjectId | null;

    @Prop({ required: true })
    name: string;

    @Prop({ required: true })
    color: string;

    @Prop({ required: true, default: 0 })
    sortOrder: number;

    @Prop({ required: true, default: true })
    isActive: boolean;
}

export const SubjectSchema = SchemaFactory.createForClass(Subject);

SubjectSchema.index({ isActive: 1, sortOrder: 1 });
