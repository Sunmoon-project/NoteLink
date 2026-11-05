import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TodoDocument = HydratedDocument<Todo>;

@Schema({ collection: 'todos', timestamps: true })
export class Todo {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId; // users 참조

  @Prop({ required: true, type: String })
  dueDate: string; // YYYY-MM-DD 형식

  @Prop({ required: true, type: String })
  content: string;

  @Prop({ required: true, type: String })
  todoType: string; // assignment, exam, general 등

  @Prop({ required: true, type: Boolean, default: false })
  isDday: boolean; // D-day 등록 여부

  @Prop({ type: String, default: null })
  timeSlot?: string;

  @Prop({ type: String, default: null })
  dueTime?: string; // 예: "23:59"

  @Prop({ required: true, type: Boolean, default: false })
  done: boolean;

  @Prop({ type: Date, default: null } ) // 완료 시각
  doneAt?: Date;
}

export const TodoSchema = SchemaFactory.createForClass(Todo);
