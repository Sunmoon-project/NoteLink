import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type RecordingDocument = HydratedDocument<Recording>;

@Schema({ collection: 'recordings', timestamps: { createdAt: true, updatedAt: false } })
export class Recording {
  @Prop({ type: Types.ObjectId, ref: 'Material', required: true })
  materialId: Types.ObjectId;

  @Prop({ required: true, type: String })
  audioUrl: string;

  @Prop({ required: true, type: Number })
  audioSizeBytes: number;

  @Prop({ required: true, type: Number })
  durationSec: number;

  @Prop({ type: Object })
  transcript?: Record<string, unknown>; // STT transcript object

  @Prop({ type: [Object], default: [] })
  slides: Record<string, unknown>[];

  @Prop({ type: String, default: null })
  visemeUrl?: string | null; // lipsync url

  @Prop({ type: [Object], default: [] })
  distractionRanges: Record<string, unknown>[];

  @Prop({ type: Object })
  summary?: Record<string, unknown>;

  @Prop({ type: String, default: null })
  keywords?: string;

  @Prop({ type: [Object], default: [] })
  bookmarks: Record<string, unknown>[];

  @Prop({ type: Date, default: null })
  deletedAt?: Date;
}

export const RecordingSchema = SchemaFactory.createForClass(Recording);
