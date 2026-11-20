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
  deletedAt?: Date | null;
}

export const RoomSharedItemSchema = SchemaFactory.createForClass(RoomSharedItem);

// 같은 방에 같은 노트를 한 번만 공유한다(지우지 않은 것 기준). 동시에 같은 요청이 와도 중복이 생기지 않게 DB가 막는다
RoomSharedItemSchema.index(
  { roomId: 1, materialId: 1 },
  {
    name: 'room_material_unique',
    unique: true,
    partialFilterExpression: { itemType: 'material', deletedAt: null },
  },
);

// 같은 방에 같은 퀴즈도 한 번만(#481). 카드 묶음은 고른 조합이 매번 다를 수 있어 막지 않는다
RoomSharedItemSchema.index(
  { roomId: 1, quizSetId: 1 },
  {
    name: 'room_quiz_unique',
    unique: true,
    partialFilterExpression: { itemType: 'quiz', deletedAt: null },
  },
);
