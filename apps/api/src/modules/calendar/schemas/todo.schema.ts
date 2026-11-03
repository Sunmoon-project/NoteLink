import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TodoDocument = HydratedDocument<Todo>;

@Schema({ collection: 'todos', timestamps: true })
export class Todo {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId; // users 참조

  @Prop({ required: true })
  dueDate: string; // YYYY-MM-DD 형식

  @Prop({ required: true })
  content: string;

  @Prop({ required: true })
  todoType: string; // assignment, exam, general 등

  @Prop({ required: true, default: false })
  isDday: boolean; // D-day 등록 여부

  @Prop()
  timeSlot?: string;

  @Prop()
  dueTime?: string; // 예: "23:59"

  @Prop({ required: true, default: false })
  done: boolean;

  @Prop()
  doneAt?: Date;
}

export const TodoSchema = SchemaFactory.createForClass(Todo);
