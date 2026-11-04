import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RoomSharedItemDocument = HydratedDocument<RoomSharedItem>;

@Schema({ collection: 'room_shared_items', timestamps: true })
export class RoomSharedItem {
  @Prop({ type: Types.ObjectId, ref: 'StudyRoom', required: true })
  roomId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  sharedBy: Types.ObjectId;

  @Prop({ required: true })
  itemType: string; // quiz_set, folder, material 등[cite: 28]

  @Prop({ type: Types.ObjectId, ref: 'QuizSet' })
  quizSetId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  folderId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Material' })
  materialId?: Types.ObjectId;

  @Prop({ type: [Types.ObjectId], default: [] })
  questionIds: Types.ObjectId[];

  @Prop({ type: [{ type: Types.ObjectId, ref: 'Flashcard' }], default: [] })
  flashcardIds: Types.ObjectId[];

  @Prop()
  deletedAt?: Date;
}

export const RoomSharedItemSchema = SchemaFactory.createForClass(RoomSharedItem);
