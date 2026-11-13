// apps/api/src/modules/auth/schemas/user.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// ==========================================
// 1단계: 메인 유저 상자 안에 넣을 작은 서브 스키마들
// ==========================================

// 1-1. 소셜 계정 연동 정보 (SocialAccount)
@Schema({ _id: false })
export class SocialAccount {
  @Prop({ required: true, type: String, enum: ['kakao', 'google', 'naver'] })
  provider: string; // kakao, google, naver 등

  @Prop({ required: true, type: String })
  providerUid: string;

  @Prop({ type: String, default: null })
  email?: string | null;

  @Prop({ required: true, type: Date, default: Date.now })
  linkedAt: Date;
}
export const SocialAccountSchema = SchemaFactory.createForClass(SocialAccount);

// 1-2. 약관 동의 정보 (TermAgreement)
@Schema({ _id: false })
export class TermAgreement {
  @Prop({ required: true, type: String })
  termCode: string;

  @Prop({ required: true, type: String })
  version: string;

  @Prop({ required: true, type: Boolean })
  agreed: boolean;

  @Prop({ required: true, type: Date, default: Date.now })
  agreedAt: Date;
}
export const TermAgreementSchema = SchemaFactory.createForClass(TermAgreement);

// 1-3. 구독 정보 (Subscription)
@Schema({ _id: false })
export class Subscription {
  @Prop({ required: true, type: String })
  tier: string; // free, pro, max 등

  @Prop({ required: true, type: String })
  status: string; // active, canceled 등

  @Prop({ required: true, type: Date })
  startedAt: Date;

  @Prop({ required: true, type: Date })
  currentPeriodEnd: Date;

  @Prop({ required: true, type: Boolean, default: false })
  autoRenew: boolean;

  @Prop({ type: Types.ObjectId, ref: 'Payment' })
  lastPaymentId?: Types.ObjectId; // payments 컬렉션 참조[발표자료 24page]

  @Prop({ type: Date, default: Date.now })
  updatedAt: Date;
}
export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);

// 2단계: 메인 User 스키마 (users 컬렉션)

export type UserDocument = HydratedDocument<User>;

@Schema({ collection: 'users', timestamps: true })
export class User {
  // 소셜 가입자는 이메일이 없어 null로 저장될 수 있다(공용 스키마 email: string | null).
  // 유일 인덱스는 아래 partialFilterExpression으로 문자열인 문서만 검사하므로 null끼리는 겹쳐도 된다.
  @Prop({ type: String, lowercase: true, trim: true, default: null })
  email?: string | null;

  @Prop({ type: String, default: null })
  passwordHash?: string | null;

  @Prop({ required: true, unique: true, index: true, type: String })
  nickname: string;

  @Prop({ required: true, type: String, default: 'user' })
  role: string;

  // 공용 스키마 LearnerType. 가입 직후엔 null, 프로필에서 나중에 정한다.
  @Prop({ type: String, enum: ['middle_high', 'university', 'worker'], default: null })
  learnerType?: string | null;

  @Prop({ required: true, type: Number, default: 0 })
  pointBalance: number; // DB 명세의 int 타입

  @Prop({ type: Object, default: {} })
  settings: Record<string, unknown>; // 환경설정 객체

  @Prop({ required: true, type: String, default: 'active' })
  status: string;

  // 다른 컬렉션(categories) 참조 배열
  @Prop({ type: [{ type: Types.ObjectId, ref: 'Category' }], default: [] })
  interestCategoryIds: Types.ObjectId[];

  // 임베디드 문서 배열 및 단일 객체 연결
  @Prop({ type: [SocialAccountSchema], default: [] })
  socialAccounts: SocialAccount[];

  @Prop({ type: [TermAgreementSchema], default: [] })
  termAgreements: TermAgreement[];

  @Prop({ type: SubscriptionSchema })
  subscription?: Subscription;

  @Prop({ type: Date, default: null })
  lastLoginAt?: Date | null;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;

  /**
   * 이 시각 이전에 발급된 로그인 토큰(access · refresh)은 받지 않는다. 비밀번호를 바꾸거나 탈퇴하면
   * 모든 기기 로그인을 끊으려고 적는다(TokenService.revokeAll)
   */
  @Prop({ type: Date, default: null })
  sessionsRevokedAt?: Date | null;

  /**
   * 로그인 세션 버전. 로그인을 끊을 때(revokeAll) 비밀번호 변경과 같은 갱신에서 1 올린다. 토큰에는 발급 때 읽은 값(sv)이
   * 들어가고, 다르면 거절한다 — 시각과 달리 「예전 비밀번호를 읽은 로그인」을 DB 반영 순서와 상관없이 걸러 낸다
   */
  @Prop({ type: Number, default: 0 })
  sessionVersion?: number;
}

export const UserSchema = SchemaFactory.createForClass(User);

// sparse는 필드가 없는 문서만 건너뛰고 email: null은 같은 값으로 취급한다.
// 문자열인 문서만 유일 인덱스에 넣어서 null · 없음은 겹쳐도 되게 한다.
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);

// 같은 소셜 계정(제공자 + 제공자 고유 번호)은 한 사용자에게만 연결된다.
// 소셜 계정이 없는 사용자(빈 배열)는 인덱스에서 빼야 서로 겹쳐도 되므로 문자열인 문서만 검사한다.
// 동시에 같은 구글 계정으로 두 번 로그인해도 사용자가 둘 만들어지지 않게 하는 마지막 방어선이다.
UserSchema.index(
  { 'socialAccounts.provider': 1, 'socialAccounts.providerUid': 1 },
  { unique: true, partialFilterExpression: { 'socialAccounts.providerUid': { $type: 'string' } } },
);
