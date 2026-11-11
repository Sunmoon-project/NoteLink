import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: RoomMember (스터디룸 참여 유저)
@Schema()
export class RoomMember {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId; // users 참조

  @Prop({ required: true, type: String, default: 'member' })
  role: string; // host, member 등

  @Prop({
    required: true,
    type: String,
    enum: ['invited', 'joined', 'left', 'kicked'],
    default: 'joined',
  })
  status: 'invited' | 'joined' | 'left' | 'kicked';

  @Prop({ type: String, enum: ['voluntary', 'host_kick', 'report'], default: null })
  leaveReason?: 'voluntary' | 'host_kick' | 'report' | null;

  @Prop({ type: Object })
  personalTimerRule?: Record<string, unknown>;

  @Prop({ type: Date, default: null })
  invitedAt?: Date | null;

  @Prop({ type: Date, default: null })
  joinedAt?: Date | null;

  @Prop({ type: Date, default: null })
  leftAt?: Date | null;

  @Prop({ type: Date, default: null })
  kickedAt?: Date | null;
}
export const RoomMemberSchema = SchemaFactory.createForClass(RoomMember);

// 메인 스키마: study_rooms
export type StudyRoomDocument = HydratedDocument<StudyRoom>;

@Schema({ collection: 'study_rooms', timestamps: true })
export class StudyRoom {
  @Prop({ required: true })
  title: string;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  categoryId: Types.ObjectId; // categories 참조

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  hostId: Types.ObjectId; // users 참조

  @Prop({ required: true, type: Boolean, default: true })
  isPublic: boolean;

  @Prop({ required: true, type: String, unique: true })
  inviteCode: string; // 방 입장 코드

  @Prop({ required: true, type: Number, default: 6 })
  maxCapacity: number;

  @Prop({ required: true, type: Number, default: 1 })
  memberCount: number;

  @Prop({ type: Object })
  timerRule?: Record<string, unknown>; // 뽀모도로 타이머 규칙

  @Prop({ type: [RoomMemberSchema], default: [] })
  members: RoomMember[]; // 참여 멤버 배열

  @Prop({ type: Date, default: null })
  closedAt?: Date | null;

}

export const StudyRoomSchema = SchemaFactory.createForClass(StudyRoom);
