import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 임베디드 문서: RoomMember (스터디룸 참여 유저)[cite: 28]
@Schema()
export class RoomMember {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId; // users 참조[cite: 28]

  @Prop({ required: true, default: 'member' })
  role: string; // host, member 등[cite: 28]

  @Prop({ required: true, default: 'joined' })
  status: string;

  @Prop({ type: Object })
  personalTimerRule?: Record<string, unknown>;

  @Prop()
  invitedAt?: Date;

  @Prop()
  joinedAt?: Date;

  @Prop()
  leftAt?: Date;

  @Prop()
  kickedAt?: Date;
}
export const RoomMemberSchema = SchemaFactory.createForClass(RoomMember);

// 메인 스키마: study_rooms[cite: 28]
export type StudyRoomDocument = HydratedDocument<StudyRoom>;

@Schema({ collection: 'study_rooms', timestamps: true })
export class StudyRoom {
  @Prop({ required: true })
  title: string;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  categoryId: Types.ObjectId; // categories 참조[cite: 28]

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  hostId: Types.ObjectId; // users 참조[cite: 28]

  @Prop({ required: true, default: true })
  isPublic: boolean;

  @Prop({ required: true, unique: true })
  inviteCode: string; // 방 입장 코드[cite: 28]

  @Prop({ required: true, default: 6 })
  maxCapacity: number;

  @Prop({ required: true, default: 1 })
  memberCount: number;

  @Prop({ type: Object })
  timerRule?: Record<string, unknown>; // 뽀모도로 타이머 규칙[cite: 28]

  @Prop({ type: [RoomMemberSchema], default: [] })
  members: RoomMember[]; // 참여 멤버 배열[cite: 28]

  @Prop()
  closedAt?: Date;
}

export const StudyRoomSchema = SchemaFactory.createForClass(StudyRoom);
