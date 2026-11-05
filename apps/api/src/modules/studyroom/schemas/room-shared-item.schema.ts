import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 공용 스키마 RoomSharedItem.itemType
export const SHARED_ITEM_TYPES = ['quiz', 'flashcards', 'material'] as const;

export type RoomSharedItemDocument = HydratedDocument<RoomSharedItem>;

@Schema({ collection: 'room_shared_items', timestamps: true })
export class RoomSharedItem {
  @Prop({ type: Types.ObjectId, ref: 'StudyRoom', required: true })
  roomId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  sharedBy: Types.ObjectId;

  @Prop({ required: true, type: String, enum: SHARED_ITEM_TYPES })
  itemType: string; // quiz · flashcards · material

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

  @Prop({ type: Date, default: null })
  deletedAt?: Date |null;
}

export const RoomSharedItemSchema = SchemaFactory.createForClass(RoomSharedItem);
