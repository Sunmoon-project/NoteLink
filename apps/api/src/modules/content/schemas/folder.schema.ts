import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FolderDocument = HydratedDocument<Folder>;

@Schema({ collection: 'folders', timestamps: true })
export class Folder {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId; // users 참조

  @Prop({ required: true, type: String })
  title: string;

  // subjects 참조. 과목 목록에 같은 이름이 없으면 null
  @Prop({ type: Types.ObjectId, ref: 'Subject', default: null })
  subjectId?: Types.ObjectId | null;

  /** 앱이 보낸 과목 이름. 과목 목록에 없는 이름도 그대로 둔다 */
  @Prop({ type: String })
  subjectName?: string;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const FolderSchema = SchemaFactory.createForClass(Folder);

// 내 폴더 목록(지우지 않은 것, 최근에 바뀐 순)
FolderSchema.index({ ownerId: 1, deletedAt: 1, updatedAt: -1 });
