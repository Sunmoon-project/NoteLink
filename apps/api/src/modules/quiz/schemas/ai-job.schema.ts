import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AiJobDocument = HydratedDocument<AIJob>;

@Schema({ collection: 'ai_jobs', timestamps: true })
export class AIJob {
  @Prop({ required: true })
  type: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  targetType: string;

  @Prop({ type: Types.ObjectId, required: true })
  targetId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  input: Record<string, any>;

  @Prop({ type: Types.ObjectId, required: true })
  result?: Record<string, any>;

  @Prop({ required: true })
  status: string; // queued, running, succeeded, failed

  @Prop({ required: true })
  progress: number; // progress(진행률)

  @Prop({ required: true })
  progressing?: Record<string, any>;

  @Prop({ required: true })
  lockedBy?: string;

  @Prop({ required: true })
  lockedUntil?: Date;

  @Prop({ required: true })
  error?: string;
}

export const AIJobSchema = SchemaFactory.createForClass(AIJob);
