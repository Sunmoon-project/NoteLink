import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// ==========================================
// 1단계: 메인 유저 상자 안에 넣을 작은 서브 스키마들
// ==========================================

// 1-1. 소셜 계정 연동 정보 (SocialAccount)
@Schema({ _id: false })
export class SocialAccount {
  @Prop({ required: true })
  provider: string; // kakao, google, naver 등

  @Prop({ required: true })
  providerUid: string;

  @Prop()
  email?: string;

  @Prop({ required: true, default: Date.now })
  linkedAt: Date;
}
export const SocialAccountSchema = SchemaFactory.createForClass(SocialAccount);

// 1-2. 약관 동의 정보 (TermAgreement)
@Schema({ _id: false })
export class TermAgreement {
  @Prop({ required: true })
  termCode: string;

  @Prop({ required: true })
  version: string;

  @Prop({ required: true })
  agreed: boolean;

  @Prop({ required: true, default: Date.now })
  agreedAt: Date;
}
export const TermAgreementSchema = SchemaFactory.createForClass(TermAgreement);

// 1-3. 구독 정보 (Subscription)
@Schema({ _id: false })
export class Subscription {
  @Prop({ required: true })
  tier: string; // free, pro, max 등

  @Prop({ required: true })
  status: string; // active, canceled 등

  @Prop({ required: true })
  startedAt: Date;

  @Prop({ required: true })
  currentPeriodEnd: Date;

  @Prop({ required: true, default: false })
  autoRenew: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Payment' })
  lastPaymentId?: Types.ObjectId; // payments 컬렉션 참조[발표자료 24page]

  @Prop({ default: Date.now })
  updatedAt: Date;
}
export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);

// 2단계: 메인 User 스키마 (users 컬렉션)

export type UserDocument = HydratedDocument<User>;

@Schema({ collection: 'users', timestamps: true })
export class User {
  @Prop()
  email?: string; // 소셜 가입자의 경우 선택 필드[cite: 24]

  @Prop()
  passwordHash?: string;

  @Prop({ required: true })
  nickname: string;

  @Prop({ required: true, default: 'user' })
  role: string;

  @Prop()
  learnerType?: string; // 중고등학생, 대학생, 직장인 등[cite: 24]

  @Prop({ required: true, default: 0 })
  pointBalance: number; // DB 명세의 int 타입[cite: 24]

  @Prop({ type: Object, default: {} })
  settings: Record<string, unknown>; // 환경설정 객체[cite: 24]

  @Prop({ required: true, default: 'active' })
  status: string;

  // 다른 컬렉션(categories) 참조 배열[cite: 24]
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Category' }], default: [] })
  interestCategoryIds: Types.ObjectId[];

  // 임베디드 문서 배열 및 단일 객체 연결[cite: 24]
  @Prop({ type: [SocialAccountSchema], default: [] })
  socialAccounts: SocialAccount[];

  @Prop({ type: [TermAgreementSchema], default: [] })
  termAgreements: TermAgreement[];

  @Prop({ type: SubscriptionSchema })
  subscription?: Subscription;

  @Prop()
  lastLoginAt?: Date;

  @Prop()
  deletedAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
