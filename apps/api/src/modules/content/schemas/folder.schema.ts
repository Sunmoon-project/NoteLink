import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FolderDocument = HydratedDocument<Folder>;

@Schema({ collection: 'folders', timestamps: true })
export class Folder {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // users 참조

  @Prop({ required: true })
  title: string;

  @Prop({ type: Types.ObjectId, ref: 'Subject' })
  subjectId: Types.ObjectId; // subjcets 참조

  @Prop()
  deletedAt: Date;
}

export const FolderSchema = SchemaFactory.createForClass(Folder);
