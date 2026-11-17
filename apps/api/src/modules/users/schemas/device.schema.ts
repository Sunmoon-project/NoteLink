import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

export type DeviceDocument = HydratedDocument<Device>;

/** 푸시 알림을 받을 기기(사용자 한 명이 여러 기기를 쓸 수 있다) */
@Schema({ collection: 'devices', timestamps: true })
export class Device {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId!: Types.ObjectId;

  @Prop({ required: true, type: String, enum: ['ios', 'android'] })
  platform!: string;

  /** 푸시 토큰은 기기 하나에 하나다. 다른 계정으로 로그인하면 그 계정으로 옮긴다 */
  @Prop({ required: true, unique: true, type: String })
  pushToken!: string;

  @Prop({ required: true, type: String })
  locale!: string;

  @Prop({ required: true, type: Date })
  lastSeenAt!: Date;
}

export const DeviceSchema = SchemaFactory.createForClass(Device);
