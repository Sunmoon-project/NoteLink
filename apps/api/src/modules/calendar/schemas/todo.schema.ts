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

  // 아래 세 필드는 할 일 · D-day API(FR-10)에서 추가했다
  @Prop({ type: Types.ObjectId, ref: 'Subject', default: null })
  subjectId?: Types.ObjectId | null; // subjects 참조 (과목 이름이 목록에 있을 때만)

  @Prop({ type: String, default: null })
  subjectName?: string | null;

  // 과제 · 시험은 두 건(그날 할 일용 isDday=false, D-day 목록용 isDday=true)이 한 쌍으로 만들어진다. 둘의 pairId가 같다
  @Prop({ type: Types.ObjectId, default: null })
  pairId?: Types.ObjectId | null;
}

export const TodoSchema = SchemaFactory.createForClass(Todo);

// 날짜별 할 일 조회, D-day 목록 조회, 짝 찾기
TodoSchema.index({ userId: 1, dueDate: 1 });
TodoSchema.index({ userId: 1, isDday: 1, done: 1 });
TodoSchema.index({ userId: 1, pairId: 1 }, { sparse: true });
