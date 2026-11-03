import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type GoalResultDocument = HydratedDocument<GoalResult>;

@Schema({ collection: 'goal_results', timestamps: { createdAt: true, updatedAt: false } })
export class GoalResult {
  @Prop({ type: Types.ObjectId, ref: 'RecurringGoal', required: true })
  goalId: Types.ObjectId; // recurring_goals 참조[cite: 26]

  @Prop({ required: true })
  studyDate: string; // YYYY-MM-DD[cite: 26]

  @Prop({ required: true, default: 0 })
  actualMin: number; // 실제 달성 시간(분)[cite: 26]

  @Prop({ required: true })
  result: string; // success, fail[cite: 26]
}

export const GoalResultSchema = SchemaFactory.createForClass(GoalResult);
