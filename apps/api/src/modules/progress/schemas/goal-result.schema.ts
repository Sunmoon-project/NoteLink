import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type GoalResultDocument = HydratedDocument<GoalResult>;

@Schema({ collection: 'goal_results', timestamps: { createdAt: true, updatedAt: false } })
export class GoalResult {
  @Prop({ type: Types.ObjectId, ref: 'RecurringGoal', required: true })
  goalId: Types.ObjectId; // recurring_goals 참조

  @Prop({ required: true, type: String })
  studyDate: string; // YYYY-MM-DD

  @Prop({ required: true, type: Number, default: 0 })
  actualMin: number; // 실제 달성 시간(분)

  @Prop({ required: true, type: String })
  result: string; // success, fail
}

export const GoalResultSchema = SchemaFactory.createForClass(GoalResult);
