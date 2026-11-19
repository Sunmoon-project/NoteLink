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

  @Prop({ type: String, default: null })
  invitationId?: string | null;

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
  @Prop({ required: true, unique: true })
  title: string;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  categoryId: Types.ObjectId; // categories 참조 — 대표 카테고리(categoryIds의 첫 번째)

  // 관심 분야와 같은 공용 카테고리 최대 3개. 예전 방은 없으므로 읽을 때 [categoryId]로 본다.
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Category' }], default: undefined })
  categoryIds?: Types.ObjectId[];

  // 대상(공용 LearnerType). 만들 때 방장 프로필에서 복사한다. 예전 방은 읽을 때 방장 값으로 본다.
  @Prop({ type: String, enum: ['middle_high', 'university', 'worker'], default: undefined })
  learnerType?: string | null;

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

  @Prop({ type: Date, default: null })
  timerStartedAt?: Date | null; // 방 전체 뽀모도로의 공통 시작 시각

  @Prop({ type: Date, default: null, index: true })
  timerNextNotificationAt?: Date | null; // 서버가 다음 단계 알림을 처리할 시각

  @Prop({ type: Number, default: 0 })
  timerRevision?: number; // 타이머 규칙이 바뀌면 이전 대기 알림을 폐기한다

  @Prop({ type: Object, default: null })
  timerPendingNotification?: Record<string, unknown> | null; // 전송 재시도용 알림 outbox

  @Prop({ type: Date, default: null })
  timerPendingLeaseUntil?: Date | null; // 여러 API 인스턴스가 같은 알림을 보내지 않게 잠근다

  @Prop({ type: [Object], default: [] })
  timerNotificationRetries?: Record<string, unknown>[]; // 푸시 실패 수신자만 분리 재시도

  @Prop({ type: Date, default: null })
  timerNotificationRetryLeaseUntil?: Date | null; // 여러 API 인스턴스의 재시도 중복을 막는다

  @Prop({ type: String, default: null })
  timerNotificationRetryLeaseToken?: string | null; // lease 갱신 중에도 재시도 큐 소유권을 확인한다

  @Prop({ type: [RoomMemberSchema], default: [] })
  members: RoomMember[]; // 참여 멤버 배열

  @Prop({ type: Date, default: null })
  closedAt?: Date | null;

  @Prop({ type: Date, default: null })
  deleteAfter?: Date | null;
}

export const StudyRoomSchema = SchemaFactory.createForClass(StudyRoom);
StudyRoomSchema.index(
  { deleteAfter: 1 },
  { partialFilterExpression: { deleteAfter: { $type: 'date' } } },
);
